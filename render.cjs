// The pull request comment's text, from a JevGate JSON report
// (.jevgate/latest.json) alone, so it renders the report of any JevGate
// version the action installs. comment.cjs posts it.
'use strict';

/** GitHub rejects a comment body over 65,536 characters. Whether it counts code
 * points or UTF-16 units, a body has at least as many UTF-8 bytes, so a body of
 * at most this many bytes fits. */
const MAX_BODY_BYTES = 65536;

/** Consider findings shown open; more are collapsed, as the agent output shows the top 10. */
const OPEN_CONSIDERS = 10;

/** Distinct reasons listed for an incomplete run; files stopped for the rest are counted. */
const MAX_REASONS = 10;

/** Jev 1.13's published rate in USD per million input tokens (output is free):
 * https://docs.typesafe.ai/models, the rate JevGate's own estimate uses. */
const USD_PER_MILLION_INPUT_TOKENS = 0.042;
const PRICED_MODEL = 'jev-1.13.0';

/** Levels in the order they are listed and kept, most severe first. */
const LEVELS = [
    { strength: 'review', title: 'Review', noun: 'review finding' },
    { strength: 'consider', title: 'Consider', noun: 'consider finding' },
    { strength: 'note', title: 'Notes', noun: 'note' },
];

/** `n` and a noun, plural unless `n` is one. */
function count(n, noun) {
    return `${number(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** An integer with thousands separators. */
function number(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The start of the hidden first line that finds this job's comment again. */
function marker(key) {
    return `<!-- jevgate-action comment key=${encodeURIComponent(key)} `;
}

/** The run that last wrote a comment, from its first line; 0 when it names none. */
function runOf(body) {
    const run = /^<!-- jevgate-action comment key=\S* run=(\d+) -->/.exec(body);
    return run ? BigInt(run[1]) : 0n;
}

/** Text outside code spans, escaped so it stays text: no links, HTML or mentions. */
function escapeText(text) {
    return text
        .replace(/[\\[\]]/g, '\\$&')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/@(?=\w)/g, '@\u200b');
}

/** The length of the run of backticks at `index`. */
function backticks(text, index) {
    let end = index;
    while (text[end] === '`') {
        end += 1;
    }
    return end - index;
}

/** Where a run of exactly `width` backticks starts at or after `from`, or -1. */
function closing(text, from, width) {
    for (let at = text.indexOf('`', from); at >= 0; ) {
        const run = backticks(text, at);
        if (run === width) {
            return at;
        }
        at = text.indexOf('`', at + run);
    }
    return -1;
}

/** Report text on one line of Markdown. Messages quote code from the change, so
 * outside code spans nothing can add HTML, links, a comment marker or mentions;
 * code spans are kept as JevGate wrote them. They are found as CommonMark finds
 * them, a run of backticks closed by a run of the same length, so text can
 * never pass as code. */
function inline(text) {
    const flat = String(text).replace(/\s*[\r\n]+\s*/g, ' ');
    let out = '';
    let at = 0;
    for (let open = flat.indexOf('`'); open >= 0; open = flat.indexOf('`', at)) {
        const width = backticks(flat, open);
        const close = closing(flat, open + width, width);
        if (close < 0) {
            // An unclosed run is escaped: left as it is, it could close on a
            // backtick of the next text in the same line and expose that
            // text's code span as Markdown and HTML.
            out += escapeText(flat.slice(at, open)) + '\\`'.repeat(width);
            at = open + width;
        } else {
            out += escapeText(flat.slice(at, open)) + flat.slice(open, close + width);
            at = close + width;
        }
    }
    return out + escapeText(flat.slice(at));
}

/** `text` as one code span, fenced by more backticks than any run it holds. */
function code(text) {
    const flat = String(text).replace(/[\r\n]+/g, ' ');
    const longest = Math.max(0, ...(flat.match(/`+/g) || []).map((run) => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A path in a URL: each segment encoded, parentheses too, so it cannot end a
 * Markdown link early. */
function urlPath(path) {
    const encode = (segment) =>
        encodeURIComponent(segment).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return path.split('/').map(encode).join('/');
}

/** A report path as a repository path, with forward slashes. */
function repositoryPath(path, run) {
    return run.prefix + (run.windows ? path.replace(/\\/g, '/') : path);
}

/** A link to `path` at the checked commit, with a line anchor or none. */
function blobUrl(path, anchor, run) {
    return `${run.serverUrl}/${run.repository}/blob/${run.commit}/${urlPath(repositoryPath(path, run))}${anchor}`;
}

/** Exit codes 0 and 1 mean the gate was applied; any other code stopped the run. */
function finished(exitCode) {
    return exitCode === 0 || exitCode === 1;
}

/** Findings nobody accepted, at a known level, with their file's path. */
function listed(report) {
    const known = new Set(LEVELS.map((level) => level.strength));
    return (report.files || []).flatMap((file) =>
        (file.findings || [])
            .filter((finding) => known.has(finding.strength) && !finding.baselined && !finding.suppressed)
            .map((finding) => ({ path: file.path, finding })),
    );
}

function levelIndex(strength) {
    return LEVELS.findIndex((level) => level.strength === strength);
}

/** Findings in the order they are kept when the comment must be cut: by level,
 * then by JevGate's rank. */
function byPriority(findings) {
    return [...findings].sort(
        (a, b) =>
            levelIndex(a.finding.strength) - levelIndex(b.finding.strength) ||
            (b.finding.rank || 0) - (a.finding.rank || 0),
    );
}

function title(exitCode) {
    if (!finished(exitCode)) {
        return '### JevGate: run incomplete';
    }
    return exitCode === 1 ? '### JevGate: gate failed' : '### JevGate: gate passed';
}

/** Distinct reasons the run could not finish, with the number of files each
 * stopped: run errors first (no files), then the errors of files not judged. */
function reasons(report) {
    const files = new Map();
    for (const error of report.errors || []) {
        files.set(error, 0);
    }
    for (const file of report.files || []) {
        if (file.status === 'error') {
            const error = file.error || 'Not judged';
            files.set(error, (files.get(error) || 0) + 1);
        }
    }
    return [...files];
}

/** The loud part of an incomplete run: what it means, then why. */
function banner(report, run) {
    const lines = [
        '> [!CAUTION]',
        `> **JevGate could not finish this run (exit code ${run.exitCode}).** The gate was not applied, and findings may be missing.`,
    ];
    const why = report ? reasons(report) : [];
    for (const [reason, files] of why.slice(0, MAX_REASONS)) {
        lines.push(`> - ${inline(reason)}${files ? ` (${count(files, 'file')})` : ''}`);
    }
    const others = why.slice(MAX_REASONS).reduce((sum, [, files]) => sum + files, 0);
    if (others > 0) {
        lines.push(`> - ${count(others, 'more file')} stopped for other reasons.`);
    }
    if (!report) {
        lines.push(`>\n> JevGate stopped before writing a report; the [job log](${run.runUrl}) says why.`);
    } else if (why.length === 0) {
        lines.push(`>\n> The [job log](${run.runUrl}) says why.`);
    }
    return lines.join('\n');
}

/** This run's cost: paid input tokens in dollars for the priced model, "cost
 * unknown" when requests were answered without a priced token count (a
 * gateway may answer without usage), or `null` when nothing was paid for. */
function cost(report) {
    const tokens = report.paid_input_tokens || 0;
    if (tokens === 0) {
        const answered = Object.values(report.stages || {}).reduce(
            (sum, stage) => sum + (stage.successful_requests || 0),
            0,
        );
        return answered > 0 ? 'cost unknown' : null;
    }
    // The model that answered, else the one asked for.
    const models = new Set((report.files || []).map((file) => file.model).filter(Boolean));
    const model = models.size > 0 ? [...models].join(', ') : report.requested_model;
    if (model !== PRICED_MODEL) {
        return 'cost unknown';
    }
    return `~$${((tokens * USD_PER_MILLION_INPUT_TOKENS) / 1e6).toFixed(4)}`;
}

/** From JevGate 0.26.0 each finding records how the gate counted it (`gate`:
 * `fails`, `measuring` or `advisory`); earlier reports have no such field, and
 * the comment then marks nothing. */
const FAILS = 'fails';
const MEASURING = 'measuring';

/** `entries` counted by level ("1 review finding and 2 consider findings"),
 * and whether that is one finding. */
function byLevel(entries) {
    const counts = LEVELS.map((level) => [
        level,
        entries.filter((entry) => entry.finding.strength === level.strength).length,
    ]).filter(([, n]) => n > 0);
    return [counts.map(([level, n]) => count(n, level.noun)).join(' and '), entries.length === 1];
}

/** Why the listed findings the gate reported without failing did not fail
 * it: their rules and levels are still being measured, or, from JevGate
 * 0.30, their file's language is in preview (`preview` names it), where
 * JevGate's own rules never fail the default gate. `null` when none. */
function measuring(all) {
    const reported = all.filter((entry) => entry.finding.gate === MEASURING);
    const measured = reported.filter((entry) => !entry.finding.preview);
    const previewed = reported.filter((entry) => entry.finding.preview);
    const reasons = [];
    if (measured.length > 0) {
        const [counted, one] = byLevel(measured);
        reasons.push(`${counted} ${one ? 'is' : 'are'} reported without failing the gate: their rules and levels are still being measured (\`jevgate rules\` shows which fail it by default).`);
    }
    if (previewed.length > 0) {
        const [counted, one] = byLevel(previewed);
        const languages = [...new Set(previewed.map((entry) => entry.finding.preview))].sort();
        const which = languages.length === 1 ? `${languages[0]} is` : `${languages.join(', ')} are`;
        reasons.push(`${counted} ${one ? 'is' : 'are'} reported without failing the gate: ${which} in preview, and by default JevGate's own rules never fail it there.`);
    }
    return reasons.length > 0 ? reasons.join(' ') : null;
}

/** The gate's reasons as JevGate gave them, what it reported without failing,
 * the run's size and cost, and the files left undecided. */
function outcome(report, all) {
    const lines = [];
    const gate = report.gate;
    if (gate && !gate.passed && (gate.reasons || []).length > 0) {
        lines.push(`Gate failed: ${gate.reasons.map(inline).join('; ')}.`);
    }
    const measured = measuring(all);
    if (measured) {
        lines.push(measured);
    }
    const files = report.files || [];
    const usage = [
        count(files.length, 'file'),
        count(report.api_requests || 0, 'API request'),
        count(report.paid_input_tokens || 0, 'input token'),
        cost(report),
    ];
    lines.push(usage.filter(Boolean).join(' · '));
    const uncertain = files.filter((file) =>
        Object.values(file.dimensions || {}).some((dimension) => dimension.status === 'uncertain'),
    ).length;
    const context = files.filter((file) => file.status === 'needs-context').length;
    const open = [
        uncertain > 0 ? `${count(uncertain, 'file')} with uncertain units` : '',
        context > 0 ? `${count(context, 'file')} needing context` : '',
    ].filter(Boolean);
    if (open.length > 0) {
        lines.push(`${open.join(' · ')}.`);
    }
    return lines.join('\n\n');
}

/** From JevGate 0.28 each review and consider records how often findings of
 * its rule and level were right on projects JevGate was never tuned on
 * (`precision`: `right` of `labeled`), and its message no longer ends with a
 * probability. Below this many labels, JevGate says it is not yet measured. */
const MIN_LABELS = 20;

/** The rule JevGate labels only on Bend 2 projects, which its table of
 * precision leaves out; its findings say so. */
const BEND_2_RULE = 'tests/laws';

/** How often findings like it were right, worded as JevGate's own output
 * words it: in a preview language (`preview`, from 0.30) that language's
 * own; nothing for a note or a report before 0.28. */
function precision(finding) {
    const { right, labeled } = finding.precision || {};
    if (!Number.isInteger(right) || !Number.isInteger(labeled)) {
        return '';
    }
    const place = finding.preview ? ` in ${finding.preview}` : '';
    if (labeled < MIN_LABELS) {
        const bend = labeled === 0 && !finding.preview && finding.rule === BEND_2_RULE;
        return bend
            ? ' Not yet measured: labeled only on Bend 2 projects, which the maturity table leaves out.'
            : ` Not yet measured${place}.`;
    }
    // Half rounded up, as JevGate rounds it.
    const percent = Math.floor((200 * right + labeled) / (2 * labeled));
    return ` Right ${percent}% of the time${place} (${labeled} labels).`;
}

/** One finding: its line, linked when the commit is known, the rule, whether
 * it fails the gate, the message, how often findings like it were right and
 * the next step. */
function item({ path, finding }, run) {
    const location = (finding.locations || []).find(
        (l) => l.path === path && l.start_line === finding.line && l.end_line > finding.line,
    );
    const anchor = location ? `#L${finding.line}-L${location.end_line}` : `#L${finding.line}`;
    const line = run.commit ? `[Line ${finding.line}](${blobUrl(path, anchor, run)})` : `Line ${finding.line}`;
    const fails = finding.gate === FAILS ? ' (fails the gate)' : '';
    return `- ${line} ${code(finding.rule)}${fails}: ${inline(finding.message)}${precision(finding)}<br>→ ${inline(finding.action)}`;
}

/** A file's heading and its findings by line. */
function fileBlock(path, entries, run) {
    const name = code(repositoryPath(path, run));
    const heading = run.commit ? `[${name}](${blobUrl(path, '', run)})` : name;
    const items = [...entries].sort((a, b) => a.finding.line - b.finding.line).map((entry) => item(entry, run));
    return [`**${heading}**`, ...items].join('\n');
}

/** One level's findings grouped by file, the files by path as the pull
 * request lists them. Reviews are open; notes, and considers past
 * `OPEN_CONSIDERS`, are collapsed. */
function section(level, shown, total, run) {
    const byPath = new Map();
    for (const entry of shown) {
        const group = byPath.get(entry.path);
        if (group) {
            group.push(entry);
        } else {
            byPath.set(entry.path, [entry]);
        }
    }
    const blocks = [...byPath.keys()].sort().map((path) => fileBlock(path, byPath.get(path), run));
    const counted = shown.length === total ? number(total) : `${number(shown.length)} of ${number(total)}`;
    if (level.strength === 'review' || (level.strength === 'consider' && total <= OPEN_CONSIDERS)) {
        return [`#### ${level.title} (${counted})`, ...blocks].join('\n\n');
    }
    const optional = level.strength === 'note' ? ', optional' : '';
    return [`<details><summary>${level.title} (${counted}${optional})</summary>`, ...blocks, '</details>'].join('\n\n');
}

/** A section for each level with findings kept, then a line for what was cut. */
function sections(kept, all, run) {
    const parts = [];
    const cut = [];
    for (const level of LEVELS) {
        const atLevel = (entry) => entry.finding.strength === level.strength;
        const shown = kept.filter(atLevel);
        const total = all.filter(atLevel).length;
        if (shown.length > 0) {
            parts.push(section(level, shown, total, run));
        }
        if (total > shown.length) {
            cut.push(count(total - shown.length, level.noun));
        }
    }
    if (cut.length > 0) {
        parts.push(
            `**${count(all.length - kept.length, 'more finding')}** did not fit in this comment: ${cut.join(', ')}. The JSON report (the action's \`report\` output) lists them all.`,
        );
    }
    return parts;
}

function footer(run) {
    const parts = [run.version ? inline(run.version) : 'JevGate'];
    if (run.commit) {
        parts.push(`commit ${run.commit.slice(0, 7)}`);
    }
    parts.push(`[workflow run](${run.runUrl})`, 'updated on each run');
    return `<sub>${parts.join(' · ')}</sub>`;
}

/** The comment for `report` (`null` when the run wrote none), listing the
 * findings in `kept` of `all`. */
function compose(report, run, kept, all) {
    const parts = [`${marker(run.key)}run=${run.runId} -->\n${title(run.exitCode)}`];
    if (!finished(run.exitCode)) {
        parts.push(banner(report, run));
    }
    if (report && report.status === 'no-changed-source') {
        parts.push('No supported file changed since the base revision.');
    } else if (report) {
        parts.push(outcome(report, all));
        if (finished(run.exitCode) && !all.some((entry) => entry.finding.strength !== 'note')) {
            parts.push('No new review or consider findings.');
        }
        parts.push(...sections(kept, all, run));
        const accepted = (report.files || [])
            .flatMap((file) => file.findings || [])
            .filter((finding) => finding.baselined || finding.suppressed).length;
        if (accepted > 0) {
            const verb = accepted === 1 ? 'is' : 'are';
            parts.push(`${count(accepted, 'finding')} accepted by the baseline or an inline allow ${verb} not listed.`);
        }
    }
    parts.push(footer(run));
    return `${parts.join('\n\n')}\n`;
}

/** The comment for a report, or for a run that wrote none (`report` null).
 * It lists as many findings as fit under GitHub's limit, cutting the lowest
 * ranked first: notes before considers before reviews. */
function render(report, run) {
    const all = report ? byPriority(listed(report)) : [];
    const body = (n) => compose(report, run, all.slice(0, n), all);
    const fits = (n) => Buffer.byteLength(body(n), 'utf8') <= MAX_BODY_BYTES;
    if (fits(all.length)) {
        return body(all.length);
    }
    // Bisect over the counts that leave a "N more" line: each finding kept
    // adds a line longer than the digits it saves there, so the size grows
    // with the count.
    let low = 0;
    let high = all.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return body(low);
}

module.exports = { render, marker, runOf, finished, inline, code, MAX_BODY_BYTES };
