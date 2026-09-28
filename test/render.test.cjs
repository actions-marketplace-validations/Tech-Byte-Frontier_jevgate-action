// Tests for the comment's text: `node --test test/render.test.cjs`. The
// reports under test/reports are JevGate's own: a --base run on its
// repository, and 0.25.0 runs without a key and after an HTTP 402.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, inline, code, marker, MAX_BODY_BYTES } = require('../render.cjs');

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const RUN = {
    key: 'review',
    runId: '123',
    runUrl: 'https://github.com/o/r/actions/runs/123',
    serverUrl: 'https://github.com',
    repository: 'o/r',
    exitCode: 1,
    commit: COMMIT,
    prefix: '',
    version: 'jevgate 0.25.0',
    windows: false,
};

function report(name) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'reports', `${name}.json`), 'utf8'));
}

function finding(strength, line, extra = {}) {
    return {
        rule: 'maintainability/shared-logic',
        strength,
        line,
        message: `Finding at line ${line}`,
        action: 'Share one implementation',
        rank: 1,
        locations: [],
        baselined: false,
        ...extra,
    };
}

/** A complete report with these files: `{ path: [findings] }`. */
function reportWith(files, extra = {}) {
    return {
        status: 'review',
        complete: true,
        errors: [],
        gate: { passed: false, reasons: ['1 new review finding'] },
        api_requests: 3,
        paid_input_tokens: 1000,
        requested_model: 'jev-1.13.0',
        stages: {},
        files: Object.entries(files).map(([file, findings]) => ({ path: file, status: 'review', findings })),
        ...extra,
    };
}

test('a real --base report lists every finding by level, then by file and line', () => {
    const body = render(report('base-run'), RUN);
    assert.ok(body.startsWith('<!-- jevgate-action comment key=review run=123 -->\n### JevGate: gate failed\n'));
    assert.match(body, /\nGate failed: 1 new review finding\(s\)\.\n/);
    assert.match(body, /\n6 files · 55 API requests · 160,708 input tokens · ~\$0\.0067\n/);
    assert.match(body, /\n3 files with uncertain units\.\n/);
    const review = body.indexOf('#### Review (1)');
    const consider = body.indexOf('#### Consider (1)');
    const notes = body.indexOf('<details><summary>Notes (11, optional)</summary>');
    assert.ok(review > 0 && consider > review && notes > consider, body);
    assert.ok(body.includes(
        `- [Line 213](https://github.com/o/r/blob/${COMMIT}/src/output.rs#L213-L217) \`maintainability/shared-logic\`: Lines 213 and 247 of \`emit_findings\``,
    ));
    // Notes: files by path, findings by line.
    const noteText = body.slice(notes);
    const files = [...noteText.matchAll(/\*\*\[`([^`]+)`\]/g)].map((m) => m[1]);
    assert.deepEqual(files, ['src/options/commands.rs', 'src/options/mod.rs', 'src/output.rs']);
    const lines = [...noteText.slice(noteText.indexOf('src/output.rs')).matchAll(/\[Line (\d+)\]/g)].map((m) => Number(m[1]));
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
    assert.ok(body.endsWith(`<sub>jevgate 0.25.0 · commit 0123456 · [workflow run](${RUN.runUrl}) · updated on each run</sub>\n`));
});

test('a run without a key says loudly that the gate was not applied, and why', () => {
    const body = render(report('no-key'), { ...RUN, exitCode: 2 });
    assert.ok(body.includes('### JevGate: run incomplete\n\n> [!CAUTION]\n> **JevGate could not finish this run (exit code 2).** The gate was not applied, and findings may be missing.\n'));
    assert.ok(body.includes('> - No API key configured. Run jevgate auth login, set TYPESAFE_API_KEY, or provide --env-file PATH (2 files)\n'));
    assert.ok(body.includes('\n2 files · 0 API requests · 0 input tokens\n'));
    assert.ok(!body.includes('No new review or consider findings'), 'nothing was judged, so nothing is clean');
});

test('an HTTP 402 lists each distinct reason with the files it stopped', () => {
    const body = render(report('http-402'), { ...RUN, exitCode: 2 });
    assert.ok(body.includes('> - TypeSafe HTTP 402; request was not retried (1 file)\n'));
    assert.ok(body.includes('> - TypeSafe request not sent after HTTP 402; restore account access and rerun the review (1 file)\n'));
    assert.ok(body.includes('2 files · 1 API request · 0 input tokens'));
});

test('run errors come first, and reasons past ten are counted', () => {
    const files = Array.from({ length: 14 }, (_, i) => ({ path: `f${i}.js`, status: 'error', error: `Reason ${i}`, findings: [] }));
    const body = render(reportWith({}, { complete: false, gate: null, errors: ['Session API request budget exhausted'], files }), { ...RUN, exitCode: 2 });
    const reasons = body.split('\n').filter((line) => line.startsWith('> - '));
    assert.equal(reasons[0], '> - Session API request budget exhausted');
    assert.equal(reasons.length, 11);
    assert.equal(reasons[10], '> - 5 more files stopped for other reasons.');
});

test('a run that wrote no report still says it stopped', () => {
    const body = render(null, { ...RUN, exitCode: 2 });
    assert.ok(body.includes(`> JevGate stopped before writing a report; the [job log](${RUN.runUrl}) says why.`));
    assert.ok(!body.includes('API request'));
});

test('from JevGate 0.26.0, findings that fail the gate and ones still being measured are marked', () => {
    const files = {
        'a.js': [
            finding('review', 1, { gate: 'fails', rule: 'maintainability/function-simplification' }),
            finding('review', 2, { gate: 'measuring' }),
            finding('consider', 3, { gate: 'measuring' }),
            finding('consider', 4, { gate: 'measuring' }),
            finding('consider', 5, { gate: 'advisory' }),
            finding('note', 6),
        ],
    };
    const body = render(reportWith(files), RUN);
    assert.ok(body.includes('`maintainability/function-simplification` (fails the gate): Finding at line 1'), body);
    assert.ok(body.includes('`maintainability/shared-logic`: Finding at line 2'));
    assert.equal(body.split('(fails the gate)').length, 2, 'only the finding that fails is marked');
    assert.ok(body.includes(
        '\n1 review finding and 2 consider findings are reported without failing the gate: their rules and levels are still being measured (`jevgate rules` shows which fail it by default).\n',
    ));
    const one = render(reportWith({ 'a.js': [finding('review', 2, { gate: 'measuring' })] }), RUN);
    assert.ok(one.includes('\n1 review finding is reported without failing the gate'));
    const older = render(report('base-run'), RUN);
    assert.ok(!older.includes('fails the gate') && !older.includes('still being measured'));
});

test('from JevGate 0.28, each finding says how often findings like it were right', () => {
    const body = render(
        reportWith({
            'src/lib.rs': [
                finding('review', 3, { precision: { right: 20, labeled: 23 } }),
                finding('consider', 9, { precision: { right: 2, labeled: 5 } }),
                finding('consider', 12),
            ],
        }),
        RUN,
    );
    assert.match(body, /Finding at line 3 Right 87% of the time \(23 labels\)\.<br>/);
    assert.match(body, /Finding at line 9 Not yet measured\.<br>/);
    assert.match(body, /Finding at line 12<br>/, 'a report before 0.28 shows none');
});

test('from JevGate 0.30, a preview language\'s findings say so, in its own precision', () => {
    const body = render(
        reportWith({
            'install.sh': [
                finding('review', 3, { gate: 'measuring', preview: 'Bash', precision: { right: 34, labeled: 50 } }),
                finding('consider', 9, { gate: 'measuring', preview: 'Bash', precision: { right: 2, labeled: 5 } }),
            ],
            'src/lib.rs': [finding('review', 4, { gate: 'measuring', precision: { right: 46, labeled: 85 } })],
            'laws.bend': [finding('consider', 7, { rule: 'tests/laws', precision: { right: 0, labeled: 0 } })],
        }),
        RUN,
    );
    assert.match(body, /Finding at line 3 Right 68% of the time in Bash \(50 labels\)\.<br>/);
    assert.match(body, /Finding at line 9 Not yet measured in Bash\.<br>/);
    assert.match(body, /Finding at line 7 Not yet measured: labeled only on Bend 2 projects, which the maturity table leaves out\.<br>/);
    assert.ok(body.includes(
        '\n1 review finding is reported without failing the gate: their rules and levels are still being measured (`jevgate rules` shows which fail it by default). 1 review finding and 1 consider finding are reported without failing the gate: Bash is in preview, and by default JevGate\'s own rules never fail it there.\n',
    ), body);
});

test('a passing gate with nothing new says so', () => {
    const body = render(reportWith({ 'a.js': [finding('note', 3)] }, { status: 'note', gate: { passed: true, reasons: [] } }), { ...RUN, exitCode: 0 });
    assert.ok(body.includes('### JevGate: gate passed\n'));
    assert.ok(!body.includes('Gate failed'));
    assert.ok(body.includes('No new review or consider findings.'));
    assert.ok(body.includes('<details><summary>Notes (1, optional)</summary>'));
});

test('no changed source is said plainly', () => {
    const body = render(reportWith({}, { status: 'no-changed-source', gate: { passed: true, reasons: [] } }), { ...RUN, exitCode: 0 });
    assert.ok(body.includes('No supported file changed since the base revision.'));
});

test('accepted findings are counted, not listed', () => {
    const files = {
        'a.js': [finding('review', 1, { baselined: true }), finding('consider', 2, { suppressed: 'generated' }), finding('consider', 9)],
    };
    const body = render(reportWith(files), RUN);
    assert.ok(!body.includes('Finding at line 1') && !body.includes('Finding at line 2'));
    assert.ok(body.includes('Finding at line 9'));
    assert.ok(body.includes('2 findings accepted by the baseline or an inline allow are not listed.'));
    assert.ok(body.includes('No new review or consider findings.') === false);
});

test('more than ten considers are collapsed; reviews never are', () => {
    const many = Array.from({ length: 11 }, (_, i) => finding('consider', i + 1));
    const reviews = Array.from({ length: 30 }, (_, i) => finding('review', i + 100));
    const body = render(reportWith({ 'a.js': [...many, ...reviews] }), RUN);
    assert.ok(body.includes('#### Review (30)'));
    assert.ok(body.includes('<details><summary>Consider (11)</summary>'));
    const ten = render(reportWith({ 'a.js': many.slice(1) }), RUN);
    assert.ok(ten.includes('#### Consider (10)'));
});

test('cost is priced for jev-1.13.0 only, and unknown when answers carried no usage', () => {
    const priced = render(reportWith({}, { paid_input_tokens: 1_000_000 }), RUN);
    assert.ok(priced.includes('1,000,000 input tokens · ~$0.0420'));
    const answered = { files: [{ path: 'a.js', status: 'clear', model: 'jev-1.13.0', findings: [] }] };
    assert.ok(render(reportWith({}, { requested_model: 'jev-latest', ...answered }), RUN).includes('~$0.0000'));
    const other = { files: [{ path: 'a.js', status: 'clear', model: 'jev-2.0.0', findings: [] }] };
    assert.ok(render(reportWith({}, other), RUN).includes('1,000 input tokens · cost unknown'));
    const noUsage = { paid_input_tokens: 0, stages: { functions: { successful_requests: 4 } } };
    assert.ok(render(reportWith({}, noUsage), RUN).includes('0 input tokens · cost unknown'));
    const cached = render(reportWith({}, { paid_input_tokens: 0, api_requests: 0 }), RUN);
    assert.ok(cached.includes('0 input tokens\n') && !cached.includes('$') && !cached.includes('cost unknown'));
});

test('a big run is cut under GitHub\'s limit, lowest ranked and least severe first', () => {
    const long = 'A message long enough to matter, quoting `some_function_name` and 漢字 text. '.repeat(3);
    const files = {};
    for (let f = 0; f < 60; f += 1) {
        files[`src/module_${f}/file.rs`] = [
            finding('review', 10, { message: long, rank: 100 + f }),
            ...Array.from({ length: 10 }, (_, i) => finding('consider', 20 + i, { message: long, rank: f + i })),
            ...Array.from({ length: 40 }, (_, i) => finding('note', 100 + i, { message: long, rank: 1000 })),
        ];
    }
    const body = render(reportWith(files), RUN);
    assert.ok(Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES);
    assert.ok(Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES - 1000, 'it uses the room it has');
    assert.ok(body.includes('#### Review (60)'), 'every review is kept');
    const considers = /Consider \((\d+) of 600\)/.exec(body);
    assert.ok(considers, body.slice(0, 2000));
    const shown = Number(considers[1]);
    assert.ok(!body.includes('Notes ('), 'notes go before any consider');
    assert.ok(body.includes(`**${(600 - shown + 2400).toLocaleString('en-US')} more findings** did not fit in this comment: ${600 - shown} consider findings, 2,400 notes.`));
    // No consider cut outranks one kept (a consider's rank is its module plus its index).
    const kept = new Set(
        [...body.matchAll(/\[Line (2\d)\]\(https:\/\/github\.com\/o\/r\/blob\/[0-9a-f]+\/src\/module_(\d+)/g)].map(
            (m) => `${m[2]}:${Number(m[1]) - 20}`,
        ),
    );
    assert.equal(kept.size, shown);
    const ranks = { kept: [], cut: [] };
    for (let f = 0; f < 60; f += 1) {
        for (let i = 0; i < 10; i += 1) {
            ranks[kept.has(`${f}:${i}`) ? 'kept' : 'cut'].push(f + i);
        }
    }
    assert.ok(Math.min(...ranks.kept) >= Math.max(...ranks.cut), `${Math.min(...ranks.kept)} < ${Math.max(...ranks.cut)}`);
});

test('a run whose findings all fit is not cut', () => {
    const files = { 'a.js': Array.from({ length: 50 }, (_, i) => finding('note', i + 1)) };
    const body = render(reportWith(files), RUN);
    assert.ok(body.includes('Notes (50, optional)') && !body.includes('did not fit'));
});

test('Windows paths and a working directory below the root become repository links', () => {
    const files = { 'src\\lib (old)\\a.js': [finding('review', 4, { locations: [{ path: 'src\\lib (old)\\a.js', start_line: 4, end_line: 9 }] })] };
    const body = render(reportWith(files), { ...RUN, windows: true, prefix: 'packages/app/' });
    assert.ok(body.includes(`**[\`packages/app/src/lib (old)/a.js\`](https://github.com/o/r/blob/${COMMIT}/packages/app/src/lib%20%28old%29/a.js)**`), body);
    assert.ok(body.includes(`[Line 4](https://github.com/o/r/blob/${COMMIT}/packages/app/src/lib%20%28old%29/a.js#L4-L9)`));
    const linux = render(reportWith({ 'a\\b.js': [finding('review', 1)] }), RUN);
    assert.ok(linux.includes('a%5Cb.js'), 'a backslash is part of a name on Linux');
});

test('without a commit, locations are not links', () => {
    const body = render(reportWith({ 'a.js': [finding('review', 4)] }), { ...RUN, commit: '' });
    assert.ok(body.includes('**`a.js`**\n- Line 4 `maintainability/shared-logic`:'));
    assert.ok(!body.includes('/blob/') && !body.includes('commit '));
});

test('text from the change cannot add HTML, links, markers or mentions', () => {
    assert.equal(inline('Value `<b>x</b>` in <b>y</b>'), 'Value `<b>x</b>` in &lt;b&gt;y&lt;/b&gt;');
    assert.equal(inline('ping @octocat, not `@octocat`'), 'ping @\u200boctocat, not `@octocat`');
    assert.equal(inline('<!-- jevgate-action comment key=review run=999 -->'), '&lt;!-- jevgate-action comment key=review run=999 --&gt;');
    assert.equal(inline('[approve](https://x.test) ![i](https://x.test/i.png)'), '\\[approve\\](https://x.test) !\\[i\\](https://x.test/i.png)');
    assert.equal(inline('line one\n# Heading\r\n> quote'), 'line one # Heading &gt; quote');
    assert.equal(inline('a &lt; b'), 'a &amp;lt; b');
    // Only a closed run of backticks is code, as CommonMark reads it; an
    // unclosed run is escaped.
    assert.equal(inline('``a` <i>'), '\\`\\`a\\` &lt;i&gt;');
    assert.equal(inline('`` a`b `` <i>'), '`` a`b `` &lt;i&gt;');
    // A backslash cannot turn a backtick into text around raw HTML.
    assert.equal(inline('\\`<img src=x>`'), '\\\\`<img src=x>`');
});

test('an unclosed backtick in a message cannot pair with the next step\'s code', () => {
    const bait = finding('review', 3, { message: 'see `', action: '`<img src=x onerror=alert(1)>` then `' });
    const body = render(reportWith({ 'a.js': [bait] }), RUN);
    assert.ok(body.includes(': see \\`<br>→ `<img src=x onerror=alert(1)>` then \\`\n'), body);
});

test('paths and rules are code spans whatever backticks they hold', () => {
    assert.equal(code('src/a.js'), '`src/a.js`');
    assert.equal(code('a`b'), '``a`b``');
    assert.equal(code('`a'), '`` `a ``');
});

test('the comment marker cannot close its HTML comment', () => {
    assert.equal(marker('review services/api'), '<!-- jevgate-action comment key=review%20services%2Fapi ');
    assert.ok(!marker('a-->b').includes('-->'));
});
