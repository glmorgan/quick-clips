import { randomUUID } from 'node:crypto';

export type TransformType = 'upper' | 'lower' | 'titlecase' | 'camelCase' | 'dashcase' | 'snakecase' | 'trim' | 'urlencode' | 'urldecode' | 'base64encode' | 'base64decode' | 'count' | 'uuid' | 'dateiso' | 'datetimeiso' | 'unixtime' | 'unixtimems';

/**
 * Transforms that produce their own output and ignore the incoming text. Callers must not
 * treat an empty clipboard as an error for these.
 */
const GENERATORS: ReadonlySet<TransformType> = new Set<TransformType>([
    'uuid', 'dateiso', 'datetimeiso', 'unixtime', 'unixtimems',
]);

export function isGenerator(transform: TransformType): boolean {
    return GENERATORS.has(transform);
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * Formats the *local* calendar date as `YYYY-MM-DD`.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which formats in UTC and therefore reports
 * the wrong day for anyone whose local date differs from UTC's at the time of use.
 */
function localDate(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Formats the local wall-clock time as `HH:mm:ss`. */
function localTime(d: Date): string {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function applyTransform(text: string, transform: TransformType): string {
    switch (transform) {
        case 'upper':
            return text.toUpperCase();
        case 'lower':
            return text.toLowerCase();
        case 'base64encode':
            return Buffer.from(text).toString('base64');
        case 'base64decode':
            return Buffer.from(text, 'base64').toString('utf8');
        case 'camelCase': {
            const words = text.trim().split(/[\s\-_]+/);
            return words[0].toLowerCase() + words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
        }
        case 'dashcase':
            return text.trim().toLowerCase().replace(/[\s_]+/g, '-');
        case 'snakecase':
            return text.trim().toLowerCase().replace(/[\s\-]+/g, '_');
        case 'titlecase':
            return text.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        case 'trim':
            return text.trim();
        case 'urlencode':
            return encodeURIComponent(text.trim());
        case 'urldecode':
            return decodeURIComponent(text.trim());
        case 'count':
            return text;
        case 'uuid':
            // Generator, not a transform — ignores the incoming text
            return randomUUID();
        case 'dateiso':
            return localDate(new Date());
        case 'datetimeiso': {
            // One Date instance so the date and time cannot straddle a midnight rollover
            const now = new Date();
            return `${localDate(now)}T${localTime(now)}`;
        }
        case 'unixtime':
            // POSIX time: whole seconds since the epoch, as `date +%s` and JWT claims use
            return String(Math.floor(Date.now() / 1000));
        case 'unixtimems':
            // Milliseconds, matching JavaScript's Date.now() and most JSON APIs
            return String(Date.now());
    }
}

/**
 * Escapes text for embedding in an AppleScript double-quoted string literal.
 *
 * AppleScript treats `\` as an escape character inside strings, so unescaped input
 * containing backslashes (Windows paths, regexes, escaped JSON, LaTeX) is either
 * mangled or fails to compile. Newlines are converted to escape sequences so the
 * generated script always stays on a single line — a raw CR would otherwise
 * terminate the statement.
 *
 * Order matters: backslashes must be doubled before any other escape is introduced.
 */
export function escapeForAppleScript(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

export function generateLabel(text: string): string {
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const maxCharsPerLine = 7;
    const maxTotalChars = maxCharsPerLine * 2;

    if (cleanText.length <= maxCharsPerLine) {
        return cleanText;
    } else if (cleanText.length <= maxTotalChars) {
        let breakPoint = cleanText.lastIndexOf(' ', maxCharsPerLine);
        if (breakPoint === -1 || breakPoint < 3) breakPoint = maxCharsPerLine;
        return `${cleanText.substring(0, breakPoint).trim()}\n${cleanText.substring(breakPoint).trim()}`;
    } else {
        const line2MaxChars = maxCharsPerLine - 1;
        let breakPoint = cleanText.lastIndexOf(' ', maxCharsPerLine);
        if (breakPoint === -1 || breakPoint < 3) breakPoint = maxCharsPerLine;
        const line1 = cleanText.substring(0, breakPoint).trim();
        let line2 = cleanText.substring(breakPoint).trim();
        if (line2.length > line2MaxChars) {
            const line2Break = line2.lastIndexOf(' ', line2MaxChars);
            line2 = line2Break > 3 ? line2.substring(0, line2Break).trim() : line2.substring(0, line2MaxChars);
        }
        return `${line1}\n${line2}…`;
    }
}
