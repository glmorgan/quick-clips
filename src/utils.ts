export type TransformType = 'upper' | 'lower' | 'titlecase' | 'camelCase' | 'dashcase' | 'snakecase' | 'trim' | 'urlencode' | 'urldecode' | 'base64encode' | 'base64decode' | 'count';

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
    }
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
