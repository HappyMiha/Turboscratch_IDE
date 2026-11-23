/* eslint-disable valid-jsdoc */

const isHighSurrogate = code => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = code => code >= 0xDC00 && code <= 0xDFFF;

/**
 * Replaces half-emoji (lone UTF-16 surrogates) with U+FFFD. The AI service
 * refuses text that contains them.
 */
const wellFormed = text => {
    if (typeof text.toWellFormed === 'function') return text.toWellFormed();
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (isHighSurrogate(code) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
            out += text[i] + text[i + 1];
            i++;
        } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
            out += '�';
        } else {
            out += text[i];
        }
    }
    return out;
};

/** Shortens text to at most max characters (plus …) without cutting an emoji in half. */
const clipText = (value, max) => {
    const text = String(value);
    if (text.length <= max) return text;
    let end = max;
    if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
    return `${text.slice(0, end)}…`;
};

export {
    clipText,
    wellFormed
};
