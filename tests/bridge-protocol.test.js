const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadTs(relativePath) {
  const file = path.join(root, relativePath);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require,
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
    { type: 'agent_lifecycle', phase: 'start', runId: 'h1' },
  ]);

  const delta = mapHermesWsEvent({ type: 'message.delta', session_id: 'h1', payload: { delta: 'llo' } }, null, 'he');
  assert.equal(delta.nextText, 'hello');
  assert.deepEqual(plain(delta.events[0]), { type: 'agent_message', runId: 'h1', text: 'hello', delta: 'llo' });

  assert.deepEqual(plain(mapHermesWsEvent({ type: 'thinking.delta', session_id: 'h1', payload: { text: 'thinking' } }, null).events[0]), {
    type: 'thinking_chunk',
    runId: 'h1',
    text: 'thinking',
  });

  assert.deepEqual(plain(mapHermesWsEvent({ type: 'tool.start', session_id: 'h1', payload: { id: 't1', name: 'read', args: { file: 'a.ts' } } }, null).events[0]), {
    type: 'tool_event',
    phase: 'start',
    runId: 'h1',
    toolCallId: 't1',
    toolName: 'read',
    args: { file: 'a.ts' },
  });

  assert.equal(mapHermesWsEvent({ type: 'message.complete', session_id: 'h1' }, null).clearBuffer, true);
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

  const chatBase = read('src/ui/chatBase.ts');
  assert.equal(/showQuickPick/.test(chatBase), false);
  assert.equal(/pickModel|pickReasoning|pickDispatch|pickEnvironment/.test(chatBase), false);
  assert.match(chatBase, /requestModelChoices/);
  assert.match(chatBase, /requestEnvironmentChoices/);

  const openclaw = read('src/bridges/openclaw/OpenClawBridge.ts');
  assert.match(openclaw, /class OpenClawBridge/);
  assert.match(openclaw, /setSessionModel/);
  assert.match(openclaw, /sendChatMessage/);

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
  const chatBase = read('src/ui/chatBase.ts');
  assert.match(chatBase, /TERMINAL_LIFECYCLE_PHASES/);
  assert.match(chatBase, /'end'/);
  assert.match(chatBase, /isTerminalLifecyclePhase\(event\.phase\)/);
  // The old hardcoded list (which omitted "end") must not come back.
  assert.equal(/\['completed',\s*'error',\s*'cancelled'\]\.includes\(event\.phase\)/.test(chatBase), false);
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

testHermesMapping();
testSouveraineMapping();
testContributionGuards();
testTerminalLifecyclePhases();
testGatewayCapabilities();

console.log('Bridge protocol tests passed');
