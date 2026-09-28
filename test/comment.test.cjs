// Tests for posting the comment: `node --test test/comment.test.cjs`, with an
// in-memory issues API standing in for GitHub.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, commentKey } = require('../comment.cjs');
const { marker } = require('../render.cjs');

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

test('each job and working directory has its own comment', () => {
    assert.equal(commentKey('review', '.'), 'review');
    assert.equal(commentKey('review', './'), 'review');
    assert.equal(commentKey('review', 'services/api'), 'review services/api');
    assert.equal(commentKey('review', './services/api/'), 'review services/api');
});

const BOT = { login: 'github-actions[bot]', type: 'Bot' };

function refusal(status, message) {
    return Object.assign(new Error(message), { status });
}

function fakeGitHub(comments = [], failures = {}) {
    const calls = [];
    let next = 1000;
    const url = (id) => `https://github.com/o/r/pull/7#issuecomment-${id}`;
    const fail = (name) => {
        if (failures[name]) {
            throw failures[name];
        }
    };
    const issues = {
        async listComments(params) {
            calls.push(['list', params.issue_number, params.per_page]);
            fail('list');
            return { data: comments.map((c) => ({ ...c, html_url: url(c.id) })) };
        },
        async createComment({ issue_number, body }) {
            calls.push(['create', issue_number]);
            fail('create');
            const comment = { id: next++, body, user: BOT };
            comments.push(comment);
            return { data: { ...comment, html_url: url(comment.id) } };
        },
        async updateComment({ comment_id, body }) {
            calls.push(['update', comment_id]);
            fail('update');
            comments.find((c) => c.id === comment_id).body = body;
            return { data: { id: comment_id, html_url: url(comment_id) } };
        },
        async deleteComment({ comment_id }) {
            calls.push(['delete', comment_id]);
            fail('delete');
            comments.splice(comments.findIndex((c) => c.id === comment_id), 1);
            return {};
        },
    };
    const github = { rest: { issues }, paginate: async (method, params) => (await method(params)).data };
    return { github, comments, calls };
}

function fakeCore() {
    const log = { info: [], warning: [], summary: [] };
    const summary = {
        addRaw(text) {
            log.summary.push(text);
            return summary;
        },
        async write() {
            return summary;
        },
    };
    return { core: { info: (m) => log.info.push(m), warning: (m) => log.warning.push(m), summary }, log };
}

function context(overrides = {}) {
    return {
        payload: { pull_request: { number: 7, head: { repo: { full_name: 'o/r' } } } },
        repo: { owner: 'o', repo: 'r' },
        job: 'review',
        runId: 123,
        serverUrl: 'https://github.com',
        ...overrides,
    };
}

function env(name, exitCode, extra = {}) {
    return {
        JEVGATE_REPORT: name ? path.join(__dirname, 'reports', `${name}.json`) : '',
        JEVGATE_EXIT_CODE: String(exitCode),
        JEVGATE_COMMIT: COMMIT,
        JEVGATE_PREFIX: '',
        JEVGATE_VERSION: 'jevgate 0.25.0',
        JEVGATE_WORKING_DIRECTORY: '.',
        ...extra,
    };
}

async function step({ comments, failures, ctx = context(), environment = env('base-run', 1) } = {}) {
    const fake = fakeGitHub(comments, failures);
    const { core, log } = fakeCore();
    await run({ github: fake.github, context: ctx, core, env: environment, platform: 'linux' });
    return { ...fake, log };
}

test('the first run creates the comment and links it from the job summary', async () => {
    const { comments, calls, log } = await step();
    assert.deepEqual(calls, [['list', 7, 100], ['create', 7]]);
    assert.equal(comments.length, 1);
    assert.ok(comments[0].body.startsWith('<!-- jevgate-action comment key=review run=123 -->\n### JevGate: gate failed'));
    assert.deepEqual(log.warning, []);
    assert.ok(log.summary[0].includes('[a pull request comment](https://github.com/o/r/pull/7#issuecomment-1000)'));
});

test('a later run updates its own comment in place and leaves others alone', async () => {
    const others = [
        { id: 1, body: `${marker('review')}run=100 -->\nquoted by a person`, user: { login: 'someone', type: 'User' } },
        { id: 2, body: `${marker('security')}run=100 -->\nanother job`, user: BOT },
        { id: 3, body: `${marker('review')}run=100 -->\nold findings`, user: BOT },
    ];
    const { comments, calls } = await step({ comments: others });
    assert.deepEqual(calls.slice(1), [['update', 3]]);
    assert.ok(comments.find((c) => c.id === 3).body.includes('### JevGate: gate failed'));
    assert.ok(comments.find((c) => c.id === 1).body.includes('quoted by a person'));
    assert.ok(comments.find((c) => c.id === 2).body.includes('another job'));
});

test('an unchanged comment is not written again', async () => {
    const first = await step();
    const again = await step({ comments: first.comments });
    assert.deepEqual(again.calls, [['list', 7, 100]]);
});

test('copies left by racing first runs are deleted, keeping the oldest', async () => {
    const racing = [4, 5, 6].map((id) => ({ id, body: `${marker('review')}run=123 -->\nrace`, user: BOT }));
    const { comments, calls } = await step({ comments: racing });
    assert.deepEqual(calls.slice(1), [['update', 4], ['delete', 5], ['delete', 6]]);
    assert.deepEqual(comments.map((c) => c.id), [4]);
});

test('a run older than the comment leaves it alone', async () => {
    const newer = [{ id: 8, body: `${marker('review')}run=124 -->\nnewer`, user: BOT }];
    const { comments, calls, log } = await step({ comments: newer });
    assert.deepEqual(calls, [['list', 7, 100]]);
    assert.ok(comments[0].body.endsWith('newer'));
    assert.ok(log.info.some((m) => m.includes('newer run')));
});

test('a read-only token is a warning in the log and the summary, not a failure', async () => {
    const failures = { create: refusal(403, 'Resource not accessible by integration') };
    const { log } = await step({ failures });
    assert.equal(log.warning.length, 1);
    assert.ok(log.warning[0].startsWith('The token cannot comment on this pull request: give the job `permissions: pull-requests: write`, or set `comment: false`.'));
    assert.ok(log.warning[0].includes('(GitHub: Resource not accessible by integration)'));
    assert.ok(log.summary[0].includes('pull-requests: write'));
});

test('a fork is told why it gets no comment', async () => {
    const fork = context({ payload: { pull_request: { number: 7, head: { repo: { full_name: 'someone/r' } } } } });
    const { log } = await step({ ctx: fork, failures: { list: refusal(404, 'Not Found') } });
    assert.ok(log.warning[0].startsWith('GitHub gives workflows on pull requests from forks a read-only token'));
});

test('any other failure is a warning, never an exception', async () => {
    const failed = await step({ failures: { update: refusal(500, 'Server Error') }, comments: [{ id: 3, body: `${marker('review')}run=1 -->`, user: BOT }] });
    assert.deepEqual(failed.log.warning, ['JevGate could not update its pull request comment: Server Error']);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jevgate-comment-'));
    const broken = path.join(directory, 'latest.json');
    fs.writeFileSync(broken, '{"files": [');
    const unreadable = await step({ environment: env('', 1, { JEVGATE_REPORT: broken }) });
    assert.equal(unreadable.calls.length, 0);
    assert.ok(unreadable.log.warning[0].startsWith('JevGate could not update its pull request comment:'));
});

test('events without a pull request, and runs without a report, post nothing', async () => {
    const push = await step({ ctx: context({ payload: {} }) });
    assert.equal(push.calls.length, 0);
    const dryRun = await step({ environment: env('', 0) });
    assert.equal(dryRun.calls.length, 0);
    assert.ok(dryRun.log.info[0].includes('no comment'));
    const stopped = await step({ environment: env('', 2) });
    assert.deepEqual(stopped.calls, [['list', 7, 100], ['create', 7]]);
    assert.ok(stopped.comments[0].body.includes('JevGate stopped before writing a report'));
});

test('a job checking a subdirectory keys its comment by it', async () => {
    const { comments } = await step({ environment: env('base-run', 1, { JEVGATE_WORKING_DIRECTORY: 'services/api' }) });
    assert.ok(comments[0].body.startsWith('<!-- jevgate-action comment key=review%20services%2Fapi run=123 -->'));
});
