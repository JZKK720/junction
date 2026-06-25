const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadTs(relativePath, requireOverrides = {}) {
  const file = path.join(root, relativePath);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const defaultOverrides = {
    vscode: {
      l10n: { t: (message, ...args) => {
        if (!args.length) return message;
        return String(message).replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? _m));
      } },
      env: { language: 'en' },
    },
  };
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(requireOverrides, specifier)) {
      if (specifier === 'vscode') {
        return { ...defaultOverrides.vscode, ...requireOverrides[specifier] };
      }
      return requireOverrides[specifier];
    }
    if (Object.prototype.hasOwnProperty.call(defaultOverrides, specifier)) {
      return defaultOverrides[specifier];
    }
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const tsPath = fs.existsSync(resolved + '.ts') ? resolved + '.ts' : (fs.existsSync(resolved) ? resolved : '');
      if (tsPath && tsPath.startsWith(root)) {
        return loadTs(path.relative(root, tsPath), requireOverrides);
      }
    }
    return require(specifier);
  };
  const context = {
    module,
    exports: module.exports,
    require: localRequire,
    __dirname: path.dirname(file),
    __filename: file,
  };
  vm.runInNewContext(js, context, { filename: file });
  return module.exports;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function testHermesMapping() {
  const { mapHermesWsEvent } = loadTs('src/bridges/hermes/events.ts');

  assert.deepEqual(plain(mapHermesWsEvent({ type: 'message.start', session_id: 'h1' }, null).events), [
    { type: 'agent_lifecycle', phase: 'start', sessionKey: 'h1', runId: 'h1' },
  ]);

  const delta = mapHermesWsEvent({ type: 'message.delta', session_id: 'h1', payload: { delta: 'llo' } }, null, 'he');
  assert.equal(delta.nextText, 'hello');
  assert.deepEqual(plain(delta.events[0]), { type: 'agent_message', sessionKey: 'h1', runId: 'h1', text: 'hello', delta: 'llo' });

  assert.deepEqual(plain(mapHermesWsEvent({ type: 'thinking.delta', session_id: 'h1', payload: { text: 'thinking' } }, null).events[0]), {
    type: 'thinking_chunk',
    sessionKey: 'h1',
    runId: 'h1',
    text: 'thinking',
  });

  assert.deepEqual(plain(mapHermesWsEvent({ type: 'tool.start', session_id: 'h1', payload: { id: 't1', name: 'read', args: { file: 'a.ts' } } }, null).events[0]), {
    type: 'tool_event',
    phase: 'start',
    sessionKey: 'h1',
    runId: 'h1',
    toolCallId: 't1',
    toolName: 'read',
    args: { file: 'a.ts' },
  });

  assert.deepEqual(plain(mapHermesWsEvent({ type: 'tool.start', session_id: 'h1', payload: { tool_id: 't2', name: 'shell', context: { command: 'pwd' } } }, null).events[0]), {
    type: 'tool_event',
    phase: 'start',
    sessionKey: 'h1',
    runId: 'h1',
    toolCallId: 't2',
    toolName: 'shell',
    args: { command: 'pwd' },
  });

  assert.deepEqual(plain(mapHermesWsEvent({ type: 'tool.complete', session_id: 'h1', payload: { tool_id: 't2', name: 'shell', result: 'ok' } }, null).events[0]), {
    type: 'tool_event',
    phase: 'result',
    sessionKey: 'h1',
    runId: 'h1',
    toolCallId: 't2',
    toolName: 'shell',
    args: {},
    result: 'ok',
    isError: false,
  });

  const complete = mapHermesWsEvent({
    type: 'message.complete',
    session_id: 'h1',
    payload: { text: 'hello!', usage: { input: 3, output: 4 } },
  }, null, 'hello');
  assert.equal(complete.clearBuffer, true);
  assert.deepEqual(plain(complete.events), [
    { type: 'agent_message', sessionKey: 'h1', runId: 'h1', text: 'hello!', delta: '!' },
    { type: 'agent_lifecycle', phase: 'completed', sessionKey: 'h1', runId: 'h1', usage: { inputTokens: 3, outputTokens: 4 } },
  ]);
}

function testGooseNativeStreamMapping() {
  const { createGooseMapperState, mapGooseStreamJsonLine } = loadTs('src/bridges/goose/events.ts');
  const state = createGooseMapperState();
  const runId = 'g1';

  assert.deepEqual(plain(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'think' }] },
  }), state).events[0]), { type: 'thinking_chunk', runId, text: 'think' });

  assert.deepEqual(plain(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: "line one\nline two\n's there" }] },
  }), state).events[0]), { type: 'thinking_chunk', runId, text: " line one line two 's there" });

  assert.deepEqual(plain(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'he' }] },
  }), state).events[0]), { type: 'agent_message', runId, text: 'he', delta: 'he' });
  assert.deepEqual(plain(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'llo' }] },
  }), state).events[0]), { type: 'agent_message', runId, text: 'hello', delta: 'llo' });

  assert.deepEqual(plain(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolRequest', id: 't1', toolCall: { value: { name: 'tree', arguments: { path: '.' } } } }],
    },
  }), state).events[0]), {
    type: 'tool_event',
    phase: 'start',
    runId,
    toolCallId: 't1',
    toolName: 'tree',
    args: { path: '.' },
  });

  assert.deepEqual(plain(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'toolResponse', id: 't1', toolResult: { value: { content: [{ type: 'text', text: 'files' }], isError: false } } }],
    },
  }), state).events[0]), {
    type: 'tool_event',
    phase: 'result',
    runId,
    toolCallId: 't1',
    toolName: 'tree',
    args: { path: '.' },
    result: { content: [{ type: 'text', text: 'files' }], isError: false },
    isError: false,
  });

  assert.deepEqual(plain(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'toolResponse', id: 't1', toolResult: { value: { content: [{ type: 'text', text: 'permission denied' }], isError: true } } }],
    },
  }), state).events[0]), {
    type: 'tool_event',
    phase: 'result',
    runId,
    toolCallId: 't1',
    toolName: 'tree',
    args: { path: '.' },
    result: { content: [{ type: 'text', text: 'permission denied' }], isError: true },
    isError: true,
  });

  assert.equal(mapGooseStreamJsonLine(runId, JSON.stringify({
    type: 'complete',
    input_tokens: 10,
    output_tokens: 2,
  }), state).finished, true);
}

function testSouveraineMapping() {
  const { mapSouveraineSseEvent } = loadTs('src/bridges/souveraine/events.ts');

  const message = mapSouveraineSseEvent('s1', 'message', JSON.stringify({ content: 'there' }), 'hi ');
  assert.equal(message.nextText, 'hi there');
  assert.deepEqual(plain(message.events[0]), { type: 'agent_message', runId: 's1', text: 'hi there', delta: 'there' });

  assert.deepEqual(plain(mapSouveraineSseEvent('s1', 'reasoning', JSON.stringify({ content: 'because' })).events[0]), {
    type: 'thinking_chunk',
    runId: 's1',
    text: 'because',
  });

  assert.deepEqual(plain(mapSouveraineSseEvent('s1', 'tool_call', JSON.stringify({
    tool_call: { id: 'tc1', function: { name: 'grep', arguments: { q: 'Bridge' } } },
  })).events[0]), {
    type: 'tool_event',
    phase: 'start',
    runId: 's1',
    toolCallId: 'tc1',
    toolName: 'grep',
    args: { q: 'Bridge' },
  });

  assert.deepEqual(plain(mapSouveraineSseEvent('s1', 'tool_return', JSON.stringify({
    tool_return: { id: 'tc1', output: 'ok', status: 'ok' },
  })).events[0]), {
    type: 'tool_event',
    phase: 'result',
    runId: 's1',
    toolCallId: 'tc1',
    result: 'ok',
    isError: false,
  });

  assert.match(mapSouveraineSseEvent('s1', 'souveraine_synthesis', JSON.stringify({ synthesis: 'merged' })).events[0].text, /\[souveraine_synthesis\] merged/);
}

function testContributionGuards() {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.contributes.chatParticipants, undefined);
  assert.equal(pkg.contributes.languageModelChatProviders, undefined);
  assert.equal(JSON.stringify(pkg.contributes).includes('openclaw.sessionsView'), false);
  assert.equal(JSON.stringify(pkg.contributes).includes('openclaw.chatView'), false);
  assert.ok(pkg.contributes.commands.every((command) => command.command.startsWith('junction.')));

  const chatBaseUi = read('src/ui/chatBase.ts') + '\n' + read('src/ui/event-router.ts');
  assert.equal(/showQuickPick/.test(chatBaseUi), false);
  assert.equal(/pickModel|pickReasoning|pickDispatch|pickEnvironment/.test(chatBaseUi), false);
  assert.match(chatBaseUi, /requestModelChoices/);
  assert.match(chatBaseUi, /requestEnvironmentChoices/);

  const openclaw = read('src/bridges/openclaw/OpenClawBridge.ts');
  const openclawModelPicker = read('src/bridges/openclaw/modelPicker.ts');
  assert.match(openclaw, /class OpenClawBridge/);
  assert.match(openclawModelPicker, /setSessionModel/);
  assert.match(openclaw, /sendChatMessage/);
  assert.match(openclaw, /recoverStaleTerminalRun/);
  assert.match(openclaw, /sessions\.describe/);
  assert.match(openclaw, /isTerminalSessionStatus/);
  assert.match(openclaw, /status === 'killed'/);

  const sessionManager = read('src/gateway/sessionManager.ts');
  assert.match(sessionManager, /sendRequest\(\s*'chat\.send'/);
  assert.doesNotMatch(sessionManager, /sendRequest\(\s*'agent'/);

  const hermes = read('src/bridges/hermes/HermesBridge.ts');
  const config = read('src/config/agentBridgeConfig.ts');
  assert.match(`${hermes}\n${config}`, /\/api\/ws/);
  assert.match(hermes, /session\.create/);
  assert.match(hermes, /prompt\.submit/);

  const souveraine = read('src/bridges/souveraine/SouveraineBridge.ts');
  assert.match(souveraine, /\/v1\/agents/);
  assert.match(souveraine, /\/v1\/conversations/);
  assert.match(souveraine, /streamSse/);
}

function testTerminalLifecyclePhases() {
  // Regression: OpenClaw's gateway emits a successful run's terminal lifecycle
  // phase as "end" (terminalLifecyclePhase ?? "end"). If chatBase only treats
  // completed/error/cancelled as terminal, activeRunId never clears and every
  // message after the first is parked in the follow-up queue forever.
  const historyManager = read('src/ui/history-manager.ts');
  assert.match(historyManager, /TERMINAL_LIFECYCLE_PHASES/);
  assert.match(historyManager, /'end'/);
  assert.match(historyManager, /isTerminalLifecyclePhase\(/);
  // The old hardcoded list (which omitted "end") must not come back.
  assert.equal(/\['completed',\s*'error',\s*'cancelled'\]\.includes\(event\.phase\)/.test(historyManager), false);
}

function testStopRunContracts() {
  const chatBase = read('src/ui/chatBase.ts');
  const agentConfig = read('src/gateway/agentConfig.ts');
  assert.match(chatBase, /const parsedSlash = parseSlashCommand\(text\)/);
  assert.match(chatBase, /this\.isLocalStopSlash\(parsedSlash\)/);
  assert.match(chatBase, /await this\.handleStopRun\(\)/);
  assert.match(chatBase, /command\.name === 'stop' \|\| command\.name === 'abort' \|\| command\.name === 'cancel'/);
  assert.match(agentConfig, /\.sendRequest\('chat\.abort'/);
  assert.match(agentConfig, /\.sendRequest\('sessions\.abort'/);
  assert.match(agentConfig, /Promise\.allSettled\(attempts\)/);
  assert.match(agentConfig, /\{ timeoutMs: 3500 \}/);
  assert.match(agentConfig, /\{ key: sessionKey, \.\.\.\(runId \? \{ runId \} : \{\}\) \}, \{ timeoutMs: 3500 \}/);

  for (const bridgePath of [
    'src/bridges/openclaw/OpenClawBridge.ts',
    'src/bridges/hermes/HermesBridge.ts',
    'src/bridges/goose/GooseBridge.ts',
    'src/bridges/opencode/OpenCodeBridge.ts',
    'src/bridges/mimocode/MiMoCodeBridge.ts',
    'src/bridges/pi/PiBridge.ts',
    'src/bridges/openhands/OpenHandsBridge.ts',
    'src/bridges/souveraine/SouveraineBridge.ts',
  ]) {
    const bridge = read(bridgePath);
    assert.match(bridge, /phase: 'cancelled'/, `${bridgePath} stopRun must emit a terminal lifecycle event`);
  }
}

function testGatewayCapabilities() {
  const { GatewayCapabilities } = loadTs('src/gateway/capabilities.ts');

  const vanilla = new GatewayCapabilities({
    protocol: 4,
    features: { methods: ['sessions.send', 'sessions.list', 'models.list'], events: [] },
    auth: { scopes: ['operator.write'] },
  });
  assert.equal(vanilla.isBoutique, false);
  assert.equal(vanilla.canSteer(), true);
  assert.equal(vanilla.hasMethod('sessions.steer'), false);

  const boutique = new GatewayCapabilities({
    protocol: 4,
    features: { methods: ['sessions.send', 'matrix.verify.status'], events: [] },
    auth: { scopes: ['operator.write'] },
  });
  assert.equal(boutique.isBoutique, true);
  assert.equal(boutique.canSteer(), true);

  const readOnly = new GatewayCapabilities({
    protocol: 4,
    features: { methods: ['sessions.send', 'matrix.verify.status'], events: [] },
    auth: { scopes: ['operator.read'] },
  });
  assert.equal(readOnly.canSteer(), false);
}

function testHistoryDedupesAssistantEchoes() {
  const { HistoryManager } = loadTs('src/ui/history-manager.ts', {
    vscode: {},
    '../utils/logger': { Logger: { getInstance: () => ({ warn() {}, info() {}, error() {} }) } },
    './toolEventHandler': { ToolEventHandler: { formatToolArgs: (v) => JSON.stringify(v), formatToolResult: (v) => String(v) } },
    './history-loader': { loadHistoryMessages: async () => ({ messages: [], source: 'none' }) },
  });

  const manager = new HistoryManager(
    () => 'id',
    (role, content) => {
      if (role === 'user' && String(content).startsWith('[Workspace File Context]')) return null;
      return content;
    },
    (msg) => msg?.content ?? msg?.message?.content ?? '',
    () => {},
  );

  const turns = manager.rebuildTurnsFromGatewayHistory([
    { role: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text: 'Done. Saved to project.' },
    ] } },
    { role: 'user', message: { role: 'user', content: '[Workspace File Context]\nCurrent file: Untitled-1' } },
    { role: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: "What's up?" },
    ] } },
    { role: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Done. Saved to project.' },
    ] } },
  ]);

  assert.deepEqual(
    plain(turns.map((turn) => ({ role: turn.role, content: turn.content }))),
    [
      { role: 'assistant', content: 'Done. Saved to project.' },
      { role: 'assistant', content: "What's up?" },
    ]
  );
}

function testOpenClawReplyMarkerGating() {
  const chatBase = read('src/ui/chatBase.ts');
  assert.match(chatBase, /extractVisibleAssistantText\(runId: string, text: string, isFinal = false\): string \| null/);
  assert.match(chatBase, /if \(!isFinal && this\.hidesRawThinking\(\) && hasThinkingStream\) \{\s*return null;\s*\}/);
  assert.match(chatBase, /const nextText = this\.extractVisibleAssistantText\(runId, event\.text \|\| lastText\);/);
  assert.match(chatBase, /const nextText = this\.extractVisibleAssistantText\(runId, event\.content \|\| lastText, event\.state === 'final'\);/);
  assert.match(chatBase, /protected hidesRawThinking\(\): boolean \{\s*return !!this\.bridgeRegistry\.active\.capabilities\.hidesRawThinking;/);
  assert.match(chatBase, /this\.appendActivityNote\(runId, delta\);/);
  assert.match(chatBase, /this\.updateThinkingTurn\(runId, buf\);/);
  assert.match(chatBase, /fullText: buf/);
  assert.match(read('src/bridges/openclaw/OpenClawBridge.ts'), /timelineInterleaves: true/);
}

function testTimelineInterleaveCapabilities() {
  for (const bridgePath of [
    'src/bridges/openclaw/OpenClawBridge.ts',
    'src/bridges/hermes/HermesBridge.ts',
    'src/bridges/goose/GooseBridge.ts',
    'src/bridges/mimocode/MiMoCodeBridge.ts',
    'src/bridges/opencode/OpenCodeBridge.ts',
  ]) {
    assert.match(read(bridgePath), /timelineInterleaves: true/, `${bridgePath} should opt into chronological timeline rendering`);
  }

  const webviewBase = read('src/ui/webview-base.ts');
  assert.match(webviewBase, /render\/timeline-interleave\.js/);
  const chatBase = read('src/ui/chatBase.ts');
  assert.match(chatBase, /interleaveTimeline: !!this\.bridgeRegistry\.active\.capabilities\.timelineInterleaves/);
  assert.match(chatBase, /renderBridgeConfig\(\)/);
  assert.match(chatBase, /compactTimelineMode: config\(\)\.get<boolean>\('compactTimelineMode', false\)/);
  assert.match(chatBase, /type: 'switchToChat'[\s\S]*\.\.\.this\.renderBridgeConfig\(\)/);
  assert.match(chatBase, /type: 'history'[\s\S]*\.\.\.this\.renderBridgeConfig\(\)/);
  assert.match(chatBase, /activeBridge: this\.bridgeRegistry\.active\.id/);
  const configManager = read('src/ui/config-manager.ts');
  assert.match(configManager, /compactTimelineMode: config\(\)\.get<boolean>\('compactTimelineMode', false\)/);
  assert.match(configManager, /affectsConfiguration\('junction\.compactTimelineMode'\)/);
  assert.match(read('src/ui/history-manager.ts'), /type: 'history', messages, \.\.\.\(this\.renderOptions \? this\.renderOptions\(\) : \{\}\)/);
  const chatStream = read('resources/webview/chat-stream.js');
  const viewRouter = read('resources/webview/view-router.js');
  const messages = read('resources/webview/render/messages.js');
  assert.match(chatStream, /if \(msg\.interleaveTimeline !== undefined\) window\.timelineInterleave = msg\.interleaveTimeline === true/);
  assert.match(chatStream, /window\.compactTimelineMode = msg\.compactTimelineMode === true/);
  assert.match(viewRouter, /if \(msg\.interleaveTimeline !== undefined\) window\.timelineInterleave = msg\.interleaveTimeline === true/);
  assert.match(viewRouter, /if \(msg\.compactTimelineMode !== undefined\) window\.compactTimelineMode = msg\.compactTimelineMode === true/);
  assert.match(messages, /var compactTimeline = !!window\.compactTimelineMode && activityUsesUnifiedTimeline\(\)/);
  assert.match(messages, /if \(compactTimeline\) worklog\.open = state !== 'done'/);
  assert.match(messages, /function dispatchActivityThoughtText\(block, text\)/);
  assert.match(messages, /var fn = window\.appendActivityThoughtText \|\| appendActivityThoughtText/);
  assert.match(messages, /dispatchActivityThoughtText\(ensureActivityThoughtBlock\(runId, row\), part\)/);
  assert.match(messages, /dispatchActivityThoughtText\(ensureActivityThoughtBlock\(runId, row\), state\.buffer\.trim\(\)\)/);
  assert.match(messages, /dispatchActivityThoughtText\(ensureActivityThoughtBlock\(runId, row\), noteText\)/);
  assert.match(read('package.json'), /"junction\.compactTimelineMode"[\s\S]*"default": false/);
}

function testSnapshotReasoningMappersEmitDeltas() {
  const { mapOpenCodeEvent, newOpenCodeMapperState } = loadTs('src/bridges/opencode/events.ts');
  const ocState = newOpenCodeMapperState();
  assert.deepEqual(plain(mapOpenCodeEvent('r1', {
    type: 'message.part.updated',
    properties: { part: { id: 'reasoning-1', type: 'reasoning', text: 'first' } },
  }, ocState).events[0]), { type: 'thinking_chunk', runId: 'r1', text: 'first' });
  assert.deepEqual(plain(mapOpenCodeEvent('r1', {
    type: 'message.part.updated',
    properties: { part: { id: 'reasoning-1', type: 'reasoning', text: 'first second' } },
  }, ocState).events[0]), { type: 'thinking_chunk', runId: 'r1', text: ' second' });
  assert.deepEqual(plain(mapOpenCodeEvent('r2', {
    type: 'session.next.reasoning.delta',
    data: { sessionID: 'ses_1', reasoningID: 'reasoning-2', delta: 'think' },
  }, newOpenCodeMapperState()).events[0]), { type: 'thinking_chunk', runId: 'r2', text: 'think' });
  assert.deepEqual(plain(mapOpenCodeEvent('r2', {
    type: 'session.next.text.delta',
    data: { sessionID: 'ses_1', textID: 'text-1', delta: 'hello' },
  }, newOpenCodeMapperState()).events[0]), { type: 'agent_message', runId: 'r2', text: 'hello' });

  const { mapMiMoCodeSseEvent } = loadTs('src/bridges/mimocode/events.ts');
  const mimoState = { reasoningParts: new Set(), reasoningAccum: new Map(), textAccum: new Map() };
  assert.deepEqual(plain(mapMiMoCodeSseEvent('m1', '', JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'reasoning-1', type: 'reasoning', text: 'alpha' } },
  }), mimoState).events[0]), { type: 'thinking_chunk', runId: 'm1', text: 'alpha' });
  assert.deepEqual(plain(mapMiMoCodeSseEvent('m1', '', JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'reasoning-1', type: 'reasoning', text: 'alpha beta' } },
  }), mimoState).events[0]), { type: 'thinking_chunk', runId: 'm1', text: ' beta' });
}

function testMiMoToolStateMapping() {
  const { mapMiMoCodeSseEvent } = loadTs('src/bridges/mimocode/events.ts');
  const state = { reasoningParts: new Set(), reasoningAccum: new Map(), textAccum: new Map() };
  const result = mapMiMoCodeSseEvent('m-tool', '', JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'call-read',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/a.txt' },
          output: '<content>hello</content>',
          metadata: { output: '<content>hello</content>', truncated: false },
        },
      },
    },
  }), state).events[0];

  assert.deepEqual(plain(result), {
    type: 'tool_event',
    phase: 'result',
    runId: 'm-tool',
    toolCallId: 'call-read',
    toolName: 'read',
    args: { filePath: '/tmp/a.txt' },
    result: '<content>hello</content>',
    isError: false,
  });
}

function testHistoryFiltersAssistantPartEchoes() {
  const historyManager = read('src/ui/history-manager.ts');
  assert.match(historyManager, /&& !seenAssistantTextsSinceVisibleUser\.has\(normalizedPart\)/);
}

function testAssistantCrumbSanitizer() {
  const { HistoryManager } = loadTs('src/ui/history-manager.ts', {
    vscode: {},
    '../utils/logger': { Logger: { getInstance: () => ({ warn() {}, info() {}, error() {} }) } },
    './toolEventHandler': { ToolEventHandler: { formatToolArgs: (v) => JSON.stringify(v), formatToolResult: (v) => String(v) } },
    './history-loader': { loadHistoryMessages: async () => ({ messages: [], source: 'none' }) },
  });

  assert.equal(
    HistoryManager.sanitizeAssistantDisplayText('The user wants\n\n">\n\nReal answer here.'),
    'Real answer here.'
  );
  assert.equal(
    HistoryManager.sanitizeAssistantDisplayText('OK so\n\nWait\n\nUseful line\n\nTyp'),
    'Useful line'
  );
}

function testHistoryBuildsActivityTimeline() {
  const historyManager = read('src/ui/history-manager.ts');
  const historyLoader = read('src/ui/history-loader.ts');
  assert.match(historyManager, /activityTimeline: turn\.activityTimeline/);
  assert.match(historyManager, /activityTimeline\.push\(\{ type: 'tool', toolCallId: tool\.toolCallId \}\)/);
  assert.match(historyManager, /const hasResult = part\.result !== undefined \|\| part\.output !== undefined/);
  assert.match(historyManager, /const isToolUseStep = stopReason === 'tooluse'/);
  assert.match(historyManager, /if \(!tool\) \{\s*tool = \{\s*toolCallId: id \|\| `restored:\$\{toolIndex\.size\}`,/);
  assert.match(historyManager, /loadHistoryMessages\(bridge, 200\)/);
  assert.match(historyLoader, /export function extractHistoryMessages/);
  assert.match(historyLoader, /Array\.isArray\(history\)\)\s*return history/);
  assert.match(historyLoader, /function loadJsonlFallback/);

  const messagesJs = read('resources/webview/render/messages.js');
  assert.match(messagesJs, /renderActivityTimelineHistory/);

  const reasoningJs = read('resources/webview/render/reasoning.js');
  assert.match(reasoningJs, /activityUsesUnifiedTimeline/);
}

function testPiHistoryPreservesNativeToolParts() {
  const { normalizePiHistoryMessages } = loadTs('src/bridges/pi/PiBridge.ts', {
    vscode: { workspace: { getConfiguration: () => ({ get: () => '' }), workspaceFolders: [] }, commands: { executeCommand: async () => {} } },
  });
  const { HistoryManager } = loadTs('src/ui/history-manager.ts', {
    vscode: {},
    '../utils/logger': { Logger: { getInstance: () => ({ warn() {}, info() {}, error() {}, captureDebugStream() {} }) } },
    './toolEventHandler': { ToolEventHandler: loadTs('src/ui/toolEventHandler.ts').ToolEventHandler },
    './history-loader': { loadHistoryMessages: async () => ({ messages: [], source: 'none' }) },
  });
  const piBridge = read('src/bridges/pi/PiBridge.ts');
  const messages = read('resources/webview/render/messages.js');
  const timelineInterleave = read('resources/webview/render/timeline-interleave.js');
  assert.match(piBridge, /normalizePiHistoryMessage/);
  assert.match(piBridge, /normalizePiHistoryMessages/);
  assert.match(piBridge, /isPiToolResultEcho/);
  assert.match(piBridge, /piHasPendingToolCall/);
  assert.match(piBridge, /normalized\.stopReason = 'tool_use'/);
  assert.match(piBridge, /normalizePiHistoryRole/);
  assert.match(piBridge, /role === 'toolResult'/);
  assert.match(piBridge, /type: 'toolCall'/);
  assert.match(piBridge, /piToolResultText\(part\.result \?\? part\.output/);
  assert.match(piBridge, /private trackToolCall\(ev: any\)/);
  assert.match(piBridge, /ev\.type === 'toolcall_start' \|\| ev\.type === 'toolcall_delta' \|\| ev\.type === 'toolcall_end'/);
  assert.match(piBridge, /compactPiListingResult/);
  assert.match(messages, /window\.mergeThoughtBlobText = mergeThoughtBlobText/);
  assert.match(timelineInterleave, /window\.mergeThoughtBlobText \? window\.mergeThoughtBlobText\(prev, raw\)/);
  assert.equal(/message\?\.\role === 'user' \? 'user' : 'assistant'/.test(piBridge), false);

  const normalized = normalizePiHistoryMessages([
    { role: 'user', content: 'read only' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'Need inspect.' },
      { type: 'text', text: 'Reading file.' },
      { type: 'toolCall', id: 'call_read', name: 'read', input: { path: 'README.md' } },
    ] },
    { role: 'assistant', content: [{ type: 'text', text: '# README\nfile body' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'Now summarize.' },
      { type: 'text', text: 'Summary here.' },
    ] },
  ]);
  assert.deepEqual(plain(normalized.map((m) => ({ role: m.role, content: m.content, toolCallId: m.toolCallId, toolName: m.toolName }))), [
    { role: 'user', content: 'read only' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'Need inspect.' },
      { type: 'text', text: 'Reading file.' },
      { type: 'toolCall', id: 'call_read', name: 'read', input: { path: 'README.md' }, isError: false },
    ] },
    { role: 'toolResult', content: '# README\nfile body', toolCallId: 'call_read', toolName: 'read' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'Now summarize.' },
      { type: 'text', text: 'Summary here.' },
    ] },
  ]);
  assert.equal(normalized[1].stopReason, 'tool_use');

  const manager = new HistoryManager(
    () => 'id',
    (role, content) => {
      if (role === 'user' && String(content).startsWith('Chat: VS Code.')) return null;
      return content;
    },
    (msg) => typeof msg.content === 'string' ? msg.content : '',
    () => {},
  );
  const turns = manager.rebuildTurnsFromGatewayHistory(normalized);
  const assistant = turns.filter((turn) => turn.role === 'assistant');
  assert.equal(assistant[0].content, 'Summary here.');
  assert.equal(assistant[0].content.includes('# README'), false);
  assert.equal(assistant[0].content.includes('Reading file.'), false);
  assert.match(assistant[0].thinking || '', /Need inspect/);
  assert.ok(assistant[0].activityTimeline?.some((item) => item.type === 'note' && /Reading file/.test(String(item.text))));
  assert.equal(assistant[0].tools?.[0]?.result, '# README\nfile body');
}

function testToolUiErrorAndChevrons() {
  const toolsJs = read('resources/webview/render/tools.js');
  assert.match(toolsJs, /deriveResultMeta/);
  assert.match(toolsJs, /errorBadge\.textContent = tr\('error', 'Error'\)/);
  assert.match(toolsJs, /appendChevron\(beforeSummary\)/);
  assert.match(toolsJs, /appendChevron\(afterSummary\)/);
  assert.match(toolsJs, /meta\.fileText/);
  assert.match(toolsJs, /buildDetailSection\(tr\('fileText', 'File text'\)/);
  assert.match(toolsJs, /if \(!resultMeta\.isError && \(meta\.plus \|\| meta\.minus\)\)/);
  assert.match(toolsJs, /function outputLabelForTool/);
  assert.match(toolsJs, /if \(verb === 'Searched'\) return tr\('results', 'Results'\)/);
  assert.match(toolsJs, /if \(kind === 'plan'\) return tr\('plan', 'Plan'\)/);
  assert.match(toolsJs, /var skipInput = meta\.kind === 'exec' \|\| meta\.kind === 'explore' \|\| meta\.kind === 'edit' \|\| meta\.kind === 'plan'/);
  assert.match(toolsJs, /function buildPlanTableSection/);
  assert.match(toolsJs, /tool-plan-table/);
  assert.match(toolsJs, /data-section', 'plan'/);
  assert.match(toolsJs, /Array\.isArray\(value\.content\)/);
  assert.match(toolsJs, /function formatContentBlock/);
  assert.match(toolsJs, /typeof value\.stdout === 'string'/);
  assert.match(toolsJs, /meta\.isError && !meta\.errorText && formattedOutput\.trim\(\)/);

  const css = read('resources/webview/chat-stream.css');
  assert.match(css, /\.tool-summary-badge/);
  assert.match(css, /\.tool-edit-subsection-summary:hover \.tool-chevron/);
  assert.match(css, /\.tool-plan-table/);
}

function testUrlLinkifyGuard() {
  const helpers = read('resources/webview/render/helpers.js');
  assert.match(helpers, /var pathRe = \/\(\?<!\["'=\\w:\/\]\)/);
}

function testTaskHistoryUx() {
  const template = read('resources/webview/template.html');
  const header = read('resources/webview/chat-header.js');
  const sessions = read('resources/webview/session-list.js');
  const eventRouter = read('src/ui/event-router.ts');
  const chatBase = read('src/ui/chatBase.ts');

  assert.match(template, /id="btn-task-history"/);
  assert.match(header, /openTaskHistoryPopover/);
  assert.match(header, /input\.addEventListener\('paste', onPaste\)/);
  assert.match(header, /e\.clipboardData.*getData\('text\/plain'\)/);
  assert.match(header, /input\.setSelectionRange\(cursor, cursor\)/);
  assert.match(sessions, /Workspace/);
  assert.match(sessions, /All threads/);
  assert.match(sessions, /requestTaskHistory/);
  assert.match(sessions, /renderTaskHistory/);
  assert.match(sessions, /flat: _taskHistory\.scope === 'folder'/);
  assert.match(eventRouter, /case 'requestTaskHistory'/);
  assert.match(chatBase, /protected sessionTitles = new Map/);
  assert.match(chatBase, /protected sessionTitle\(key/);
  assert.match(chatBase, /this\.sessionTitles\.set\(key, label\)/);
}

function testCodeRewindHidden() {
  const messages = read('resources/webview/render/messages.js');
  const activity = read('resources/webview/activity-modules.js');
  const config = read('src/ui/config-manager.ts');
  const checkpointManager = read('src/checkpoints/checkpointManager.ts');
  const pkg = read('package.json');

  assert.equal(/Fork & rewind|Rewind code to here|rewindToMessage/.test(messages), false);
  assert.equal(/label: 'Undo'|rewindToMessage/.test(activity), false);
  assert.match(config, /betaForkRewind: false/);
  assert.match(checkpointManager, /checkpoints\.enabled', false/);
  assert.match(pkg, /"junction\.checkpoints\.enabled"[\s\S]*"default": false/);
}

function testHermesNativeBridgeMethods() {
  const hermes = read('src/bridges/hermes/HermesBridge.ts');

  assert.match(hermes, /session\.branch/);
  assert.match(hermes, /session\.steer/);
  assert.match(hermes, /session\.title/);
  assert.match(hermes, /session\.usage/);
  assert.match(hermes, /session\.list/);
  assert.match(hermes, /session\.create', \{\s*title,\s*source: 'vscode'/);
  assert.match(hermes, /commands\.catalog/);
  assert.match(hermes, /state\.db/);
  assert.match(hermes, /tool_calls/);
  assert.match(hermes, /mode === 'apiserver'[\s\S]*connectApiServer/);
  assert.equal(/mode === 'auto'[\s\S]*connectApiServer/.test(hermes), false);
  assert.equal(/submitSlash\(`\/steer/.test(hermes), false);
  assert.equal(/Mirrors Hermes' own COMMAND_REGISTRY/.test(hermes), false);
}

function testHermesToolResultObjects() {
  const { ToolEventHandler } = loadTs('src/ui/toolEventHandler.ts');

  assert.equal(
    ToolEventHandler.formatToolResult({ content: 'file body', truncated: true, hint: 'read next chunk' }, false),
    'file body\n\nread next chunk'
  );
  assert.equal(
    ToolEventHandler.formatToolResult({ output: 'ran\n', exit_code: 7 }, false),
    'ran\n\nExit code: 7'
  );
}

function testSlashCommandContract() {
  const types = read('src/bridges/types.ts');
  const helper = read('src/bridges/slashCommands.ts');
  const chatBase = read('src/ui/chatBase.ts');
  assert.match(types, /executeSlashCommand\?\(command: string, context\?: BridgeContext\): Promise<any>/);
  assert.match(helper, /parseSlashCommand/);
  assert.match(chatBase, /parseSlashCommand\(text\)[\s\S]*dispatchSlashCommand\(text\)/);
  assert.match(chatBase, /executeSlashCommand\(text, dispatchContext\)/);
  assert.match(chatBase, /executeSlashCommand\(command, ctx\)/);
  assert.match(chatBase, /hydrateModelSelection/);
  assert.match(chatBase, /persistModelSelection/);
  assert.equal(/const modelItem = selectedParent \?\? choices\[0\]/.test(chatBase), false);

  for (const bridgePath of [
    'src/bridges/openclaw/OpenClawBridge.ts',
    'src/bridges/hermes/HermesBridge.ts',
    'src/bridges/goose/GooseBridge.ts',
    'src/bridges/mimocode/MiMoCodeBridge.ts',
    'src/bridges/opencode/OpenCodeBridge.ts',
  ]) {
    const bridge = read(bridgePath);
    assert.match(bridge, /executeSlashCommand\(/, `${bridgePath} missing executeSlashCommand`);
    assert.match(bridge, /getSelection\(/, `${bridgePath} missing getSelection`);
  }
  assert.match(read('src/bridges/mimocode/MiMoCodeBridge.ts'), /\/command/);
  assert.match(read('src/bridges/opencode/OpenCodeBridge.ts'), /opencodeApiUrl\(this\.baseUrl, 'command'\)/);
  const goose = read('src/bridges/goose/GooseBridge.ts');
  assert.match(goose, /'run', '--quiet'/);
  assert.match(goose, /--output-format', 'stream-json'/);
  assert.match(goose, /session', 'export'/);
  const hermes = read('src/bridges/hermes/HermesBridge.ts');
  assert.match(hermes, /commands\.catalog/);
  assert.match(hermes, /slash\.exec/);
  assert.match(hermes, /command\.dispatch/);
  assert.equal(/executeHermesSlash[\s\S]*prompt\.submit', \{ session_id: liveId, text \}/.test(hermes), false);
}

function testOpenCodeMiMoParityContracts() {
  const helper = read('src/bridges/mimocode/sessionApi.ts');
  const opencode = read('src/bridges/opencode/OpenCodeBridge.ts');
  const mimocode = read('src/bridges/mimocode/MiMoCodeBridge.ts');
  const opencodePicker = read('src/bridges/opencode/modelPicker.ts');
  const pkg = read('package.json');

  assert.match(helper, /listMiMoCodeSessions/);
  assert.match(helper, /decorateMiMoCodeSessions/);
  assert.match(helper, /withDirectory/);
  assert.match(opencode, /listWorkspaceSessions\(scope: ChatScope/);
  assert.match(opencode, /bindSessionWorkspace\(this\.context, this\.id/);
  assert.match(opencode, /private spawnCliRun\(input:/);
  assert.match(opencode, /\['run', '--format', 'json', '--thinking', '--dir', cwd\]/);
  assert.match(opencode, /args\.push\('--session', input\.sessionId\)/);
  assert.match(opencode, /args\.push\('--model', model\)/);
  assert.match(opencode, /private adoptNativeCliSession/);
  assert.match(opencode, /private mapCliRunEvent/);
  assert.match(opencode, /private sessionModelParts\(\): OpenCodeSessionModelRef \| null/);
  assert.match(opencode, /id: selected\.model/);
  assert.match(opencode, /opencode-pending-/);
  assert.match(opencode, /this\.stopServerProcess\(\)/);
  assert.match(opencode, /private eventLocationKey = ''/);
  assert.match(opencode, /private startEventStream\(folderUri\?: vscode\.Uri\): void/);
  assert.match(opencode, /const eventUrl = opencodeApiUrl\(this\.baseUrl, 'event', vscode\.Uri\.file\(nextLocation\)\)/);
  assert.match(opencode, /function isNativeOpenCodeSessionId/);
  assert.match(opencode, /private async ensureNativeSession/);
  assert.equal(/method: 'POST'[\s\S]*session\/\$\{encodeURIComponent\(sessionId\)\}\/message/.test(opencode), false);
  assert.equal(/body: \{ prompt: \{ text/.test(opencode), false);
  assert.equal(/session\/\$\{encodeURIComponent\(id\)\}\/wait/.test(opencode), false);
  assert.equal(/const id = `opencode-\$\{Date\.now\(\)\}`/.test(opencode), false);
  assert.equal(/withDirectory\(this\.baseUrl/.test(opencode), false);
  assert.match(mimocode, /listWorkspaceSessions\(scope: ChatScope/);
  assert.match(mimocode, /bindMiMoCodeSessionWorkspace/);
  assert.match(mimocode, /\/command`/);
  assert.match(mimocode, /listOpenCodeModelChoices\(this\.serverUrl/);
  assert.match(mimocode, /withDirectory\(this\.serverUrl!/);
  assert.match(pkg, /"junction\.mimocode\.home"[\s\S]*"default": ""/);
  assert.match(opencodePicker, /\/api\/model/);
  assert.match(opencodePicker, /groupV2Models/);
  assert.equal(/stripProviderFromModel: true/.test(opencodePicker), false);
}

function testGeneralBridgeParityContracts() {
  const types = read('src/bridges/types.ts');
  const chatBase = read('src/ui/chatBase.ts');
  const registry = read('src/bridges/registry.ts');
  const bindings = read('src/bridges/sessionBindings.ts');
  const openclawWorkspace = read('src/bridges/openclaw/workspaceSessions.ts');
  const hermesWorkspace = read('src/bridges/hermes/workspaceSessions.ts');
  const hidden = read('src/bridges/hiddenContext.ts');
  const errors = read('src/bridges/errors.ts');
  const sandbox = read('src/bridges/sandboxControls.ts');
  const hermes = read('src/bridges/hermes/HermesBridge.ts');

  assert.match(types, /listWorkspaceSessions\?\(scope: ChatScope/);
  assert.match(types, /bindSessionWorkspace\?\(sessionKey: string/);
  assert.match(types, /injectHiddenContext\?\(sessionKey: string, context: BridgeContext, message: string\): Promise<boolean>/);
  assert.match(bindings, /bindSessionWorkspace/);
  assert.match(bindings, /decorateSessionsWithWorkspaceBindings/);
  assert.match(openclawWorkspace, /listOpenClawWorkspaceSessions/);
  assert.match(openclawWorkspace, /getOwnedSessions/);
  assert.match(hermesWorkspace, /decorateHermesWorkspaceSessions/);
  assert.match(hermesWorkspace, /decorateSessionsWithWorkspaceBindings/);
  assert.match(hermesWorkspace, /hermesNativeWorkspaceBinding/);
  assert.match(hermes, /cwd from sessions/);
  assert.match(chatBase, /listBridgeSessions\(nextScope, false\)/);
  assert.match(chatBase, /this\.bridge\.bindSessionWorkspace\?\./);
  assert.match(chatBase, /this\.bridge\.boundSessionWorkspace\?\./);
  assert.match(hidden, /buildHiddenWorkspaceContext/);
  assert.match(chatBase, /ensureHiddenWorkspaceContext/);
  assert.match(chatBase, /const outboundText = hiddenContextOk \? text : this\.withWorkspaceContext/);
  assert.match(errors, /normalizeBridgeError/);
  assert.match(errors, /Session busy/);
  assert.match(chatBase, /normalizeBridgeError\(error\)\.message/);
  assert.match(chatBase, /finally \{\s*if \(runId\) this\.finalizeRun\(runId\)/);
  assert.match(hermes, /getSessionHistoryFromJsonl\(sessionKey: string/);
  assert.match(hermes, /getContextUsage\(sessionKey: string\)/);
  assert.match(hermes, /injectHiddenContext\(sessionKey: string/);
  assert.match(registry, /const visible: ChoiceMenuItem\[\] = \[\]/);
  assert.match(registry, /const disconnected: ChoiceMenuItem\[\] = \[\]/);
  assert.match(registry, /if \(isActive \|\| hasConfigured\) visible\.push\(item\)/);
  assert.match(registry, /label: t\('Disconnected bridges'\)/);
  assert.match(registry, /children: disconnected/);
  assert.match(read('src/bridges/mimocode/MiMoCodeBridge.ts'), /const detected = configured !== '' \|\| mimoInstalled\(\)/);
  assert.match(read('src/bridges/mimocode/MiMoCodeBridge.ts'), /setup: !detected/);
  assert.match(read('src/bridges/opencode/OpenCodeBridge.ts'), /const detected = ocInstalled\(\)/);
  assert.match(read('src/bridges/opencode/OpenCodeBridge.ts'), /setup: !detected/);
  assert.match(read('src/bridges/openhands/OpenHandsBridge.ts'), /setup: !connected/);
  assert.equal(/label: 'Read only'/.test(sandbox.match(/const HERMES_PROFILE[\s\S]*?const PROFILES/)?.[0] || ''), false);
  assert.match(sandbox, /label: 'YOLO'/);
}

function testMouseThumbNavigation() {
  const navigation = read('resources/webview/navigation.js');
  const viewRouter = read('resources/webview/view-router.js');
  const webviewBase = read('src/ui/webview-base.ts');
  const eventRouter = read('src/ui/event-router.ts');
  const chatBase = read('src/ui/chatBase.ts');

  assert.match(webviewBase, /navigation\.js/);
  assert.match(navigation, /event\.button !== 3 && event\.button !== 4/);
  assert.match(navigation, /vscode\.postMessage\(\{ type: 'restoreNavigation', state: target \}\)/);
  assert.match(navigation, /junctionRecordNavigation/);
  assert.match(navigation, /bridgeId/);
  assert.match(navigation, /sessionKey/);
  assert.match(viewRouter, /junctionRecordNavigation\(\{\s*view: 'home'/);
  assert.match(viewRouter, /junctionRecordNavigation\(\{\s*view: 'chat'/);
  assert.match(viewRouter, /window\.junctionActiveSessionKey/);
  assert.match(eventRouter, /case 'restoreNavigation'/);
  assert.match(chatBase, /handleRestoreNavigation/);
  assert.match(chatBase, /this\.bridgeRegistry\.setActive\(bridgeId\)/);
  assert.match(chatBase, /this\.postToWebview\(\{ type: 'switchToHome', \.\.\.this\.renderBridgeConfig\(\) \}\)/);
}

function testToolResultFriendlyFixtures() {
  const { ToolEventHandler } = loadTs('src/ui/toolEventHandler.ts');

  assert.equal(
    ToolEventHandler.formatToolResult(JSON.stringify({ content: 'alpha\nbeta', total_lines: 2 }), false),
    'alpha\nbeta'
  );
  assert.equal(
    ToolEventHandler.formatToolResult(JSON.stringify({ total_count: 2, matches_text: 'a.ts\n  1: alpha' }), false),
    'a.ts\n  1: alpha'
  );
  assert.equal(
    ToolEventHandler.formatToolResult(JSON.stringify({ files: ['a.ts', 'b.ts'] }), false),
    'a.ts\nb.ts'
  );
  assert.equal(
    ToolEventHandler.formatToolResult({ output: 'ran\n', exit_code: 0 }, false),
    'ran\n\nExit code: 0'
  );
}

function testLocalizationSupport() {
  const pkg = JSON.parse(read('package.json'));
  const locales = ['zh-cn', 'hi', 'de', 'fr', 'ru', 'ko', 'ja', 'ar', 'pt-br'];
  const pkgNls = JSON.parse(read('package.nls.json'));
  const runtimeBundle = JSON.parse(read('l10n/bundle.l10n.json'));
  const l10nTs = read('src/l10n.ts');
  const webviewBase = read('src/ui/webview-base.ts');
  const webviewL10n = read('resources/webview/l10n.js');
  const goodFonts = read('resources/webview/good-fonts.css');

  assert.equal(pkg.name, 'junction');
  assert.match(pkg.displayName, /^%junction\./);
  assert.match(pkg.description, /^%junction\./);
  assert.match(pkg.contributes.commands[0].title, /^%junction\./);
  assert.match(pkg.contributes.viewsContainers.secondarySidebar[0].title, /^%junction\./);
  assert.ok(Object.keys(pkgNls).length > 50);
  assert.equal(pkgNls['junction.displayName.junction'], 'Junction');
  for (const locale of locales) {
    const localizedPkg = JSON.parse(read(`package.nls.${locale}.json`));
    const localizedRuntime = JSON.parse(read(`l10n/bundle.l10n.${locale}.json`));
    assert.deepEqual(Object.keys(pkgNls).sort(), Object.keys(localizedPkg).sort());
    assert.deepEqual(Object.keys(runtimeBundle).sort(), Object.keys(localizedRuntime).sort());
    assert.equal(localizedPkg['junction.displayName.junction'], 'Junction');
  }

  assert.match(l10nTs, /export const t = vscode\.l10n\.t/);
  assert.match(l10nTs, /webviewL10nBundle/);
  assert.match(webviewBase, /webviewL10nBundle\(\)/);
  assert.match(webviewBase, /JUNCTION_L10N/);
  assert.match(webviewBase, /'l10n\.js'/);
  assert.match(webviewL10n, /window\.junctionT = t/);
  assert.match(webviewL10n, /window\.junctionLocale = locale/);
  assert.match(webviewL10n, /locale-cjk/);
  assert.match(webviewL10n, /locale-devanagari/);
  assert.match(webviewL10n, /data-l10n-placeholder/);
  assert.equal(runtimeBundle['Junction: connected to {0}'], 'Junction: connected to {0}');
  assert.match(l10nTs, /locale: vscode\.env\.language/);
  assert.match(goodFonts, /body\.locale-cjk/);
  assert.match(goodFonts, /body\.locale-devanagari/);
}

function testSplashStartupRendersCleanly() {
  const template = read('resources/webview/template.html');
  const chatStream = read('resources/webview/chat-stream.js');
  const animations = read('resources/webview/render/animations.js');

  assert.match(template, /id="startup-fallback-wordmark">Junction<\/div>/);
  assert.match(template, /#startup-loader\.real-splash-ready #startup-fallback-wordmark/);
  assert.match(template, /canvas paints only the background veil/);
  assert.equal(/ctx\.fillText\('Junction'/.test(template), false);

  assert.match(chatStream, /startupLoader\.classList\.add\('real-splash-ready'\)/);
  assert.match(chatStream, /fallbackWordmark\.remove\(\)/);

  assert.match(animations, /function splashEntryY\(goesDown\)/);
  assert.match(animations, /y: splashEntryY\(initDown\)/);
  assert.match(animations, /function splashIntroAlpha\(\)/);
  assert.match(animations, /ctx\.globalAlpha = splashIntroAlpha\(\)/);
  assert.equal(/Math\.random\(\) \* \(canvas\.height \+ fontSize \* 8\)/.test(animations), false);
}

function testDebugCaptureHelpers() {
  const { debugStreamName, newDebugRunId, redactDebugPayload } = loadTs('src/utils/debugCapture.ts', {
    './logger': { Logger: { getInstance: () => ({ captureDebugStream() {} }) } },
  });

  assert.equal(debugStreamName('hermes', 'request'), 'bridge-hermes-request');
  assert.equal(debugStreamName('pi', 'history-native'), 'bridge-pi-history-native');
  assert.equal(debugStreamName('Open Code', 'normalized'), 'bridge-open-code-normalized');
  assert.equal(debugStreamName('ignored', 'render-mode-state'), 'render-mode-state');

  const id = newDebugRunId('pi', 'send chat');
  assert.match(id, /^pi:send-chat:/);

  const redacted = redactDebugPayload({
    sessionKey: 'safe-session',
    modelId: 'safe-model',
    apiKey: 'bad',
    nested: {
      authorization: 'Bearer bad',
      refreshToken: 'bad',
      cookie: 'bad',
      value: 'ok',
    },
    long: 'x'.repeat(21000),
  });
  assert.equal(redacted.sessionKey, 'safe-session');
  assert.equal(redacted.modelId, 'safe-model');
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.authorization, '[REDACTED]');
  assert.equal(redacted.nested.refreshToken, '[REDACTED]');
  assert.equal(redacted.nested.cookie, '[REDACTED]');
  assert.equal(redacted.nested.value, 'ok');
  assert.match(redacted.long, /\[TruncatedString\]$/);
}

function testModelPickerDisplayAndThinkingContracts() {
  const { modelChoiceDisplay } = loadTs('src/bridges/modelPicker.ts');

  assert.equal(modelChoiceDisplay({ label: 'MiMo-V2.5-Pro' }, 'mimo-v2.5-pro'), 'MiMo-V2.5-Pro');
  assert.equal(modelChoiceDisplay({ label: 'high', thinking: 'high' }, 'mimo-v2.5-pro'), 'mimo-v2.5-pro');

  const pickerPaths = [
    'src/bridges/openclaw/modelPicker.ts',
    'src/bridges/hermes/modelPicker.ts',
    'src/bridges/goose/modelPicker.ts',
    'src/bridges/opencode/modelPicker.ts',
    'src/bridges/mimocode/modelPicker.ts',
    'src/bridges/souveraine/modelPicker.ts',
    'src/bridges/openhands/modelPicker.ts',
  ];

  for (const pickerPath of pickerPaths) {
    const picker = read(pickerPath);
    assert.match(picker, /modelChoiceDisplay/, `${pickerPath} must keep model display separate from thinking labels`);
    assert.equal(/display:\s*String\(data\.label\s*\?\?/.test(picker), false, `${pickerPath} may show "high high" for thinking submenu rows`);
  }

  const pi = read('src/bridges/pi/PiBridge.ts');
  assert.match(pi, /modelChoiceDisplay\(data, model\)/);
  assert.match(pi, /syncSelectionFromState\(state\)/);
  assert.match(pi, /thinkingLevelMap/);
  assert.match(pi, /const PI_THINKING_LEVELS = \['off', 'minimal', 'low', 'medium', 'high', 'xhigh'\]/);
  assert.equal(/OPENCLAW_THINKING_LEVELS/.test(pi), false);
  assert.equal(/provider === 'xiaomi'/.test(pi), false);
}

function testEveryBridgeHasDebugCapture() {
  const sharedChat = read('src/ui/chatBase.ts');
  const sharedHistory = read('src/ui/history-manager.ts');
  const helper = read('src/utils/debugCapture.ts');
  const bridgePaths = [
    'src/bridges/openclaw/OpenClawBridge.ts',
    'src/bridges/hermes/HermesBridge.ts',
    'src/bridges/goose/GooseBridge.ts',
    'src/bridges/opencode/OpenCodeBridge.ts',
    'src/bridges/mimocode/MiMoCodeBridge.ts',
    'src/bridges/pi/PiBridge.ts',
    'src/bridges/openhands/OpenHandsBridge.ts',
    'src/bridges/souveraine/SouveraineBridge.ts',
  ];

  assert.match(helper, /export function captureBridgeDebug/);
  assert.match(helper, /export function captureBridgeHistoryDebug/);
  assert.match(helper, /export function captureRenderDebug/);
  assert.match(sharedChat, /captureBridgeDebug/);
  assert.match(sharedChat, /captureRenderDebug/);
  assert.match(sharedHistory, /captureBridgeHistoryDebug/);

  for (const bridgePath of bridgePaths) {
    const bridge = read(bridgePath);
    assert.match(bridge, /captureBridgeDebug/, `${bridgePath} missing stream/request debug capture`);
    assert.match(bridge, /captureBridgeHistoryDebug/, `${bridgePath} missing history debug capture`);
    assert.match(bridge, /'request'/, `${bridgePath} missing request debug lane`);
    assert.match(bridge, /'normalized'/, `${bridgePath} missing normalized debug lane`);
    assert.match(bridge, /'history-native'/, `${bridgePath} missing native history debug lane`);
    assert.match(bridge, /'history-normalized'/, `${bridgePath} missing normalized history debug lane`);
  }
}

function testRenderModeDebugCapture() {
  const chatBase = read('src/ui/chatBase.ts');
  const history = read('src/ui/history-manager.ts');

  assert.match(chatBase, /captureRenderDebug\(type/);
  assert.match(chatBase, /summarizeWebviewMessage/);
  assert.match(chatBase, /messageType: message\?\.type/);
  assert.match(chatBase, /messageCount: rows\.length/);
  assert.match(chatBase, /assistantCount/);
  assert.match(chatBase, /assistantBodyLength/);
  assert.match(chatBase, /thinkingLength/);
  assert.match(chatBase, /toolCount/);
  assert.match(chatBase, /activityTimelineCount/);
  assert.match(chatBase, /interleaveTimeline: message\?\.interleaveTimeline/);
  assert.match(chatBase, /compactTimelineMode: message\?\.compactTimelineMode/);
  assert.match(chatBase, /renderMode: message\?\.renderMode \?\? message\?\.viewMode \?\? 'unknown'/);
  assert.match(chatBase, /rawJsonLookingContent/);
  assert.match(chatBase, /\.\.\.this\.renderBridgeConfig\(\)/);
  assert.match(history, /chat-history-webview/);
  assert.equal(/captureRenderDebug/.test(read('src/bridges/hermes/HermesBridge.ts')), false);
  assert.equal(/captureRenderDebug/.test(read('src/bridges/goose/GooseBridge.ts')), false);
}

function testBridgeReplayFixtureCoverage() {
  const bridgeIds = ['openclaw', 'hermes', 'goose', 'opencode', 'mimocode', 'pi', 'openhands', 'souveraine'];
  const testSource = read('tests/bridge-protocol.test.js');
  for (const id of bridgeIds) {
    assert.match(testSource, new RegExp(id.replace('-', '[-]?'), 'i'), `missing replay/static coverage for ${id}`);
  }

  const { extractThinkingFromSessionMessage } = loadTs('src/bridges/openclaw/events.ts');
  assert.deepEqual(plain(extractThinkingFromSessionMessage({
    sessionKey: 'oc1',
    message: { content: [{ type: 'thinking', thinking: 'hidden thought' }, { type: 'text', text: 'visible' }] },
  })), [{ type: 'thinking_chunk', text: 'hidden thought', sessionKey: 'oc1' }]);

  const { mapOpenHandsEvent } = loadTs('src/bridges/openhands/events.ts');
  assert.deepEqual(plain(mapOpenHandsEvent('oh1', {
    kind: 'ACTION',
    tool_name: 'shell',
    id: 'a1',
    arguments: { command: 'pwd' },
  }).tools[0]), {
    type: 'tool_event',
    phase: 'start',
    runId: 'oh1',
    toolCallId: 'a1',
    toolName: 'shell',
    args: { command: 'pwd' },
  });
  assert.deepEqual(plain(mapOpenHandsEvent('oh1', {
    kind: 'OBSERVATION',
    tool_call_id: 'a1',
    content: 'ok',
  }).tools[0]), {
    type: 'tool_event',
    phase: 'result',
    runId: 'oh1',
    toolCallId: 'a1',
    result: 'ok',
    isError: false,
  });

  const hermes = read('src/bridges/hermes/HermesBridge.ts');
  const goose = read('src/bridges/goose/GooseBridge.ts');
  const opencode = read('src/bridges/opencode/OpenCodeBridge.ts');
  const mimocode = read('src/bridges/mimocode/MiMoCodeBridge.ts');
  const pi = read('src/bridges/pi/PiBridge.ts');
  const souveraine = read('src/bridges/souveraine/SouveraineBridge.ts');
  assert.match(hermes, /hermesDbRowToHistoryMessage/);
  assert.match(goose, /normalizeGooseHistory/);
  assert.match(opencode, /recordPart\(runState, 'tool:'/);
  assert.match(mimocode, /normalizeMiMoToolPart/);
  assert.match(pi, /normalizePiHistoryMessages/);
  assert.match(souveraine, /mapSouveraineSseEvent/);
}

testHermesMapping();
testGooseNativeStreamMapping();
testSouveraineMapping();
testContributionGuards();
testTerminalLifecyclePhases();
testStopRunContracts();
testGatewayCapabilities();
testHistoryDedupesAssistantEchoes();
testOpenClawReplyMarkerGating();
testTimelineInterleaveCapabilities();
testSnapshotReasoningMappersEmitDeltas();
testMiMoToolStateMapping();
testHistoryFiltersAssistantPartEchoes();
testAssistantCrumbSanitizer();
testHistoryBuildsActivityTimeline();
testPiHistoryPreservesNativeToolParts();
testModelPickerDisplayAndThinkingContracts();
testToolUiErrorAndChevrons();
testUrlLinkifyGuard();
testTaskHistoryUx();
testCodeRewindHidden();
testHermesNativeBridgeMethods();
testHermesToolResultObjects();
testSlashCommandContract();
testOpenCodeMiMoParityContracts();
testGeneralBridgeParityContracts();
testMouseThumbNavigation();
testToolResultFriendlyFixtures();
testLocalizationSupport();
testSplashStartupRendersCleanly();
testDebugCaptureHelpers();
testEveryBridgeHasDebugCapture();
testRenderModeDebugCapture();
testBridgeReplayFixtureCoverage();

console.log('Bridge protocol tests passed');
