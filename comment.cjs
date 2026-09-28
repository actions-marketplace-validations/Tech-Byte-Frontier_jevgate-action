// Posts the comment render.cjs writes on the pull request, one per job, and
// updates it in place on each run. It never fails the job: the gate decides that.
'use strict';

const fs = require('node:fs');
const { render, marker, runOf, finished } = require('./render.cjs');

/** What tells this job's comment from other JevGate jobs' on one pull request:
 * the job, and the directory it checks unless that is the root. */
function commentKey(job, directory) {
    const relative = directory.replace(/^(\.\/+)+/, '').replace(/\/+$/, '');
    return ['', '.'].includes(relative) ? job : `${job} ${relative}`;
}

/** This run's report, or `null` when the check wrote none. */
function readReport(path) {
    return path ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
}

/** What the comment says about this run besides the report: the workflow's
 * context, and the check step's outputs in `env`. */
function runDetails(context, env, platform) {
    const repository = `${context.repo.owner}/${context.repo.repo}`;
    return {
        key: commentKey(context.job, env.JEVGATE_WORKING_DIRECTORY || '.'),
        runId: String(context.runId),
        runUrl: `${context.serverUrl}/${repository}/actions/runs/${context.runId}`,
        serverUrl: context.serverUrl,
        repository,
        exitCode: Number(env.JEVGATE_EXIT_CODE),
        commit: env.JEVGATE_COMMIT || '',
        prefix: env.JEVGATE_PREFIX || '',
        version: env.JEVGATE_VERSION || '',
        windows: platform === 'win32',
    };
}

/** GitHub refused the token: say why in the log and the job summary. */
async function cannotComment(core, pullRequest, repository, error) {
    const head = pullRequest.head && pullRequest.head.repo;
    const why =
        head && head.full_name !== repository
            ? 'GitHub gives workflows on pull requests from forks a read-only token, so JevGate cannot comment here'
            : 'The token cannot comment on this pull request: give the job `permissions: pull-requests: write`, or set `comment: false`';
    const text = `${why}. The findings are in the annotations and the job summary. (GitHub: ${error.message})`;
    core.warning(text);
    await core.summary.addRaw(`\n${text}\n`, true).write();
}

/** A refusal of the token: no permission, or a pull request it cannot see. */
function refused(error) {
    return error.status === 403 || error.status === 404;
}

/** Create the comment, or update this job's, keeping the oldest and deleting
 * copies that two first runs racing each other left. A run older than the one
 * that last wrote the comment leaves it alone, so a slow run for an earlier
 * push cannot replace a later one's findings. Returns the comment's URL, or
 * `null` when it was left alone. */
async function upsert(github, target, body, run) {
    const { owner, repo } = target;
    const comments = await github.paginate(github.rest.issues.listComments, { ...target, per_page: 100 });
    const ours = comments.filter(
        (c) => c.user && c.user.type === 'Bot' && typeof c.body === 'string' && c.body.startsWith(marker(run.key)),
    );
    if (ours.length === 0) {
        const { data } = await github.rest.issues.createComment({ ...target, body });
        return data.html_url;
    }
    const [kept, ...copies] = ours;
    if (runOf(kept.body) > BigInt(run.runId)) {
        return null;
    }
    let url = kept.html_url;
    if (kept.body !== body) {
        const { data } = await github.rest.issues.updateComment({ owner, repo, comment_id: kept.id, body });
        url = data.html_url;
    }
    for (const copy of copies) {
        await github.rest.issues.deleteComment({ owner, repo, comment_id: copy.id });
    }
    return url;
}

/** The step's entry point, called by actions/github-script with its client,
 * context and core; the check step's outputs arrive in `env`. */
async function run({ github, context, core, env = process.env, platform = process.platform }) {
    try {
        const pullRequest = context.payload.pull_request;
        if (!pullRequest) {
            core.info('JevGate comments only on pull request events.');
            return;
        }
        const report = readReport(env.JEVGATE_REPORT);
        const details = runDetails(context, env, platform);
        if (!report && finished(details.exitCode)) {
            core.info('This check wrote no report in the working directory (a dry run writes none); no comment.');
            return;
        }
        const body = render(report, details);
        let url;
        try {
            url = await upsert(github, { ...context.repo, issue_number: pullRequest.number }, body, details);
        } catch (error) {
            if (!refused(error)) {
                throw error;
            }
            await cannotComment(core, pullRequest, details.repository, error);
            return;
        }
        if (url === null) {
            core.info('A newer run already updated the JevGate comment; it is left as it is.');
            return;
        }
        core.info(`JevGate comment: ${url}`);
        await core.summary.addRaw(`\nThe findings are also in [a pull request comment](${url}).\n`, true).write();
    } catch (error) {
        core.warning(`JevGate could not update its pull request comment: ${error.message}`);
    }
}

module.exports = { run, commentKey };
