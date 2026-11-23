import PropTypes from 'prop-types';
import React from 'react';
import styles from './ada-panel.css';

/**
 * Shows Ada's answers with a little formatting: paragraphs, headings, lists
 * (indented lists are how she writes scripts), **bold**, `code` and code
 * blocks. It builds React elements, never HTML, so nothing in an answer can
 * run as code.
 */

const renderInline = (text, keyPrefix) => {
    const parts = [];
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let match;
    let n = 0;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('**')) {
            parts.push(<strong key={`${keyPrefix}-${n++}`}>{token.slice(2, -2)}</strong>);
        } else {
            parts.push(<code key={`${keyPrefix}-${n++}`}>{token.slice(1, -1)}</code>);
        }
        last = match.index + token.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
};

const SimpleMarkdown = ({text}) => {
    const lines = text.replace(/\r/g, '').split('\n');
    const out = [];
    let paragraph = [];
    let code = null;

    const flushParagraph = () => {
        if (!paragraph.length) return;
        const key = `p${out.length}`;
        out.push(<p key={key}>{renderInline(paragraph.join(' '), key)}</p>);
        paragraph = [];
    };

    for (const line of lines) {
        if (code !== null) {
            if (/^\s*```/.test(line)) {
                out.push(<pre key={`c${out.length}`}>{code.join('\n')}</pre>);
                code = null;
            } else {
                code.push(line);
            }
            continue;
        }
        if (/^\s*```/.test(line)) {
            flushParagraph();
            code = [];
            continue;
        }
        const list = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (list) {
            flushParagraph();
            const indent = Math.min(list[1].replace(/\t/g, '    ').length, 24);
            const marker = /\d/.test(list[2]) ? list[2] : '•';
            const key = `l${out.length}`;
            out.push(
                <div
                    key={key}
                    className={styles.mdListItem}
                    style={{paddingLeft: `${0.4 + (indent * 0.45)}rem`}}
                >
                    <span className={styles.mdMarker}>{marker}</span>
                    <span>{renderInline(list[3], key)}</span>
                </div>
            );
        } else if (heading) {
            flushParagraph();
            const key = `h${out.length}`;
            out.push(<p key={key}><strong>{renderInline(heading[1], key)}</strong></p>);
        } else if (line.trim() === '') {
            flushParagraph();
        } else {
            paragraph.push(line.trim());
        }
    }
    if (code !== null) out.push(<pre key={`c${out.length}`}>{code.join('\n')}</pre>);
    flushParagraph();
    return <div className={styles.markdown}>{out}</div>;
};

SimpleMarkdown.propTypes = {
    text: PropTypes.string.isRequired
};

export default SimpleMarkdown;
