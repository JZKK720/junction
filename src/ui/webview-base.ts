/**
 * ChatBaseWebview — webview creation, HTML template assembly, and CSS/JS asset
 * URI resolution for the Junction chat UI.
 *
 * Extracted from chatBase.ts to reduce the main class's surface area.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Logger } from '../utils/logger';

/**
 * Assemble the modular webview HTML from resources/webview/.
 * Reads template.html, replaces CSP/nonce/asset placeholders, links every
 * component stylesheet, and injects the JS module scripts (markdown-it +
 * component modules, central dispatcher last) before </body>.
 */
export function buildWebviewHtml(
    extensionUri: vscode.Uri,
    webview: vscode.Webview
): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const webviewDir = vscode.Uri.joinPath(extensionUri, 'resources', 'webview');
    const assetUri = (file: string) =>
        webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, file)).toString();
    const mdUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js')
    ).toString();

    let html: string;
    try {
        html = fs.readFileSync(vscode.Uri.joinPath(webviewDir, 'template.html').fsPath, 'utf8');
    } catch (e) {
        Logger.getInstance().error('Failed to read webview template', e);
        return '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1rem">Failed to load Junction chat UI.</body></html>';
    }

    // Component stylesheets beyond tokens/codicon (those have own placeholders).
    const cssFiles = [
        'good-fonts.css',
        'view-router.css', 'choice-menu.css', 'chat-header.css', 'session-list.css',
        'attached-files-bar.css', 'composer.css', 'chat-stream.css',
        'activity-accordion.css', 'activity-timeline.css',
    ];
    // Module scripts: define-globals modules first, central dispatcher
    // (view-router.js) last. markdown-it before chat-stream (which uses it).
    const jsFiles = [
        'choice-menu.js', 'chat-header.js', 'session-list.js', 'attached-files-bar.js',
        'render/helpers.js', 'render/animations.js', 'render/messages.js',
        'render/reasoning.js', 'activity-modules.js', 'render/tools.js', 'render/working.js',
        'settings/config-section.js', 'settings/bubble-section.js', 'settings/preview.js', 'settings/splash-section.js',
        'composer.js', 'chat-stream.js', 'view-router.js',
    ];

    const cssLinks = cssFiles
        .map((f) => `  <link rel="stylesheet" href="${assetUri(f)}">`)
        .join('\n');
    const moduleScripts = [
        `  <script nonce="${nonce}" src="${mdUri}"></script>`,
        `  <script nonce="${nonce}" src="${assetUri('pretext.bundle.js')}"></script>`,
        `  <script nonce="${nonce}">window.JUNCTION_ACTIVITY_TIMELINE_JS_URI=${JSON.stringify(assetUri('activity-timeline.js'))};</script>`,
        ...jsFiles.map((f) => `  <script nonce="${nonce}" src="${assetUri(f)}"></script>`),
    ].join('\n');

    html = html
        .replace(/\$\{NONCE_PLACEHOLDER\}/g, nonce)
        .replace(/\$\{CSP_SOURCE_PLACEHOLDER\}/g, webview.cspSource)
        .replace(/\$\{TOKENS_CSS_URI\}/g, assetUri('tokens.css'))
        .replace(/\$\{CODICON_CSS_URI\}/g, assetUri('codicon.css'));

    // The template has a single ${CHAT_CSS_URI} <link>; expand it into the
    // full component stylesheet chain.
    html = html.replace(
        /[ \t]*<link rel="stylesheet" href="\$\{CHAT_CSS_URI\}">/,
        cssLinks
    );

    // Inject module scripts AFTER the template's inline <script> so composer.js
    // can clone-and-rewire the inline listeners and view-router.js can override
    // the inline nav stubs.
    html = html.replace('</body>', moduleScripts + '\n</body>');

    return html;
}

/**
 * Wire up the onDidReceiveMessage handler for a webview. Returns the
 * disposable so the caller can manage cleanup.
 * The handler dispatches to a provided callback for each message.
 */
export function wireWepviewMessageHandler(
    webview: vscode.Webview,
    handler: (data: any) => Promise<void>
): vscode.Disposable {
    return webview.onDidReceiveMessage(async (data) => {
        await handler(data);
    });
}
