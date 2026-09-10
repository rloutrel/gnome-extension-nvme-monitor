import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

const COVERAGE_DIR = process.argv[2];
const SOURCE_ROOT = process.argv[3];

if (!COVERAGE_DIR || !SOURCE_ROOT) {
    console.error('Usage: node v8ToLcov.js <coverage-dir> <source-root>');
    process.exit(1);
}

const sourceRoot = realpathSync(SOURCE_ROOT);

function safePath(filePath, baseDir) {
    const resolved = realpathSync(filePath);
    if (resolved !== baseDir && !resolved.startsWith(baseDir + '/')) {
        console.error(`Error: path '${filePath}' is outside the allowed directory: ${resolved}`);
        process.exit(1);
    }
    return resolved;
}

const coverageDir = safePath(COVERAGE_DIR, sourceRoot);
const outputPath = join(sourceRoot, 'coverage.lcov');

const lcov = [];

function offsetToLine(lineStarts, offset) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

function buildLineStarts(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

for (const file of readdirSync(coverageDir)) {
    if (!file.startsWith('coverage-') || !file.endsWith('.json')) continue;
    const data = JSON.parse(readFileSync(safePath(join(coverageDir, file), sourceRoot), 'utf8'));

    for (const script of data.result) {
        const url = script.url;
        if (!url) continue;

        let filePath;
        if (url.startsWith('file://')) {
            filePath = url.slice('file://'.length);
        } else if (url.startsWith('node:')) {
            continue;
        } else {
            continue;
        }

        let resolvedPath;
        try {
            resolvedPath = safePath(filePath, sourceRoot);
        } catch {
            continue;
        }

        const relPath = relative(sourceRoot, resolvedPath);
        const source = readFileSync(resolvedPath, 'utf8');
        const lineStarts = buildLineStarts(source);

        const allRanges = [];
        let totalFns = 0;
        let coveredFns = 0;

        for (const fn of script.functions || []) {
            if (!fn.ranges || fn.ranges.length === 0) continue;
            totalFns++;
            const topLevel = fn.ranges[0];
            if (topLevel.count > 0) coveredFns++;

            for (const r of fn.ranges) {
                allRanges.push({
                    start: r.startOffset,
                    end: r.endOffset,
                    count: r.count,
                    length: r.endOffset - r.startOffset,
                });
            }
        }

        allRanges.sort((a, b) => b.length - a.length);

        const lineHits = new Map();
        for (const r of allRanges) {
            const startLine = offsetToLine(lineStarts, r.start);
            const endLine = offsetToLine(lineStarts, r.end);
            for (let l = startLine; l <= endLine; l++) {
                lineHits.set(l, r.count);
            }
        }

        lcov.push(`SF:${relPath}`);
        for (const [line, hits] of [...lineHits.entries()].sort((a, b) => a[0] - b[0])) {
            lcov.push(`DA:${line},${hits}`);
        }
        lcov.push(`FNF:${totalFns}`);
        lcov.push(`FNH:${coveredFns}`);
        const coveredLines = [...lineHits.values()].filter(h => h > 0).length;
        lcov.push(`LF:${lineHits.size}`);
        lcov.push(`LH:${coveredLines}`);
        lcov.push('end_of_record');
    }
}

writeFileSync(outputPath, lcov.join('\n') + '\n');
console.log(`LCOV written to ${outputPath} (${lcov.filter(l => l.startsWith('SF:')).length} files)`);
