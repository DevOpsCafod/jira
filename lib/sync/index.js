const { Subscription } = require('../models')
const getJiraClient = require('../jira/client')
// const getJiraUtil = require('../util')
const { getCommits, getPullRequests } = require('./queries')

const Queue = require('bull')
const transformPullRequest = require('../transforms/pull-request')
const transformCommit = require('../transforms/commit')

const discoverContentQueue = new Queue('Content discovery', 'redis://127.0.0.1:6379')
const pullRequestQueue = new Queue('Pull Requests transformation', 'redis://127.0.0.1:6379')
const commitQueue = new Queue('Commit transformation', 'redis://127.0.0.1:6379')

module.exports = async (robot) => {
  const router = robot.route('/jira/sync')

  const processPullRequests = require('./pull-request')(robot)

  async function discoverContent (job) {
    const github = await robot.auth(job.data.installationId)
    const { data } = await github.apps.getInstallationRepositories()
    robot.log(`${data.total_count} Repositories for Installation: ${job.data.installationId}`)

    return data.repositories.forEach(async repository => {
      const pullsName = `PullRequests-${repository.name}`
      const commitsName = `Commits-${repository.name}`

      pullRequestQueue.add(pullsName,
        {
          installationId: job.data.installationId,
          jiraHost: job.data.jiraHost,
          repository
        },
        { jobId: pullsName }
      )

      pullRequestQueue.process(pullsName, processPullRequests)

      commitQueue.add(commitsName, {
        installationId: job.data.installationId,
        jiraHost: job.data.jiraHost,
        repository
      }, { jobId: commitsName })
      commitQueue.on('error', (err) => { robot.log.error(err) })
      commitQueue.on('failed', (job, err) => { robot.log.error({job, err}) })
      commitQueue.process(commitsName, processCommits)
    })
  }

  async function processCommits (job) {
    const { installationId, jiraHost, repository } = job.data
    const subscription = await Subscription.getSingleInstallation(jiraHost, installationId)
    if (!subscription) {
      return
    }

    const jiraClient = await getJiraClient(subscription.id, installationId, subscription.jiraHost)
    // TODO: figure out what Jira Util does
    // const util = getJiraUtil(jiraClient)

    const github = await robot.auth(installationId)
    let commitsData = (await github.query(getCommits, {
      owner: repository.owner.login,
      repo: repository.name,
      per_page: 2
    })).repository.ref.target.history.nodes

    const authors = commitsData.map(item => item.author)

    const commits = commitsData.map(item => {
      // translating the object into a schema that matches our transforms
      return {
        author: item.author,
        authorTimestamp: item.authoredDate,
        fileCount: item.changedFiles,
        sha: item.oid,
        message: item.message,
        url: item.url
      }
    })

    const { data, commands } = transformCommit({ commits, repository }, authors)

    if (!data) {
      // robot.log(`No Jira issue found on commits for ${repository.name}`)
      return
    }

    robot.log('jira commits:', data)
    await jiraClient.devinfo.updateRepository(data)
  }


  router.get('/', async (req, res) => {
    req.log('Starting Jira sync')

    // TODO: cleaning queues before each request while testing
    discoverContentQueue.clean(5000)
    pullRequestQueue.clean(5000)
    commitQueue.clean(5000)

    const name = `Discover-${req.query.installationId}`

    discoverContentQueue.add(name, { installationId: req.query.installationId, jiraHost: req.query.host }, { jobId: name })
    discoverContentQueue.process(name, discoverContent)

    return res.sendStatus(202)
  })
}