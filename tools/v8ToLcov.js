import { readFileSync, writeFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

const COVERAGE_DIR = process.argv[2];
const OUTPUT_PATH = process.argv[3];
const SOURCE_ROOT = process.argv[4];

if (!COVERAGE_DIR || !OUTPUT_PATH || !SOURCE_ROOT) {
    console.error('Usage: node v8ToLcov.js <coverage-dir> <output-lcov> <source-root>');
    process.exit(1);
}

const sourceRoot = resolve(SOURCE_ROOT);

function validatePath(p, label, mustExistDir = false) {
    const canonical = resolve(p);
    if (!isAbsolute(canonical) || canonical.includes('..')) {
        console.error(`Error: ${label} is not a safe absolute path: ${p}`);
        process.exit(1);
    }
    if (!canonical.startsWith(sourceRoot + '/') && canonical !== sourceRoot) {
        console.error(`Error: ${label} escapes source root: ${canonical}`);
        process.exit(1);
    }
    if (mustExistDir) {
        const real = realpathSync(canonical);
        if (real !== canonical) {
            console.error(`Error: ${label} contains a symlink redirect: ${canonical}`);
            process.exit(1);
        }
        if (!real.startsWith(sourceRoot)) {
            console.error(`Error: ${label} realpath escapes source root: ${real}`);
            process.exit(1);
        }
    }
    return canonical;
}

const coverageDir = validatePath(COVERAGE_DIR, 'coverage dir', true);
const outputPath = validatePath(OUTPUT_PATH, 'output path');

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
    const data = JSON.parse(readFileSync(join(COVERAGE_DIR, file), 'utf8'));

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

        const resolvedPath = resolve(filePath);
        if (!resolvedPath.startsWith(sourceRoot)) continue;
        if (!existsSync(resolvedPath)) continue;
        filePath = resolvedPath;

        const relPath = relative(sourceRoot, filePath);
        const source = readFileSync(filePath, 'utf8');
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
