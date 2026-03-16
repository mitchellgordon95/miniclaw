# MiniClaw Design Document

**Goal**: Build a minimal personal assistant daemon that uses Claude Code for all agent interactions, supporting multi-channel input (web UI, SMS) and periodic heartbeats.

**Key Constraint**: Use Mitchell's Claude Max subscription (no API costs), keep codebase simple and understandable.

---

## Architecture Overview

```
miniclaw/
├── server.js              # Express server: web UI, SMS webhook, orchestration
├── sessions/
│   └── main.json          # Single persistent conversation history
├── cron/
│   └── jobs.json          # Cron job definitions (heartbeat + custom tasks)
├── workspace/             # Existing OpenClaw workspace (AGENTS.md, SOUL.md, etc.)
├── secrets/               # API keys, credentials (gitignored)
├── logs/                  # Agent turn logs, debug info
├── lib/
│   ├── claude.js          # Claude Code process manager
│   ├── channels.js        # Multi-channel routing (web, SMS)
│   ├── context.js         # Context window management & compaction
│   ├── cron.js            # Cron job scheduler
│   └── session.js         # Session state management
└── public/
    └── index.html         # Web chat UI
```

---

## Core Components

### 1. Session State Management (`lib/session.js`)

**Responsibilities:**
- Load/save conversation history from `sessions/main.json`
- Append messages (atomic writes, crash-safe)
- Provide context for Claude Code (full history + metadata)
- Handle context window limits (stub for now, implement compaction later)

**Message Format:**
```json
{
  "role": "user" | "assistant" | "system",
  "content": "...",
  "timestamp": "2026-03-16T15:00:00Z",
  "channel": "web" | "sms" | "voice" | "heartbeat",
  "messageId": "unique-id",
  "metadata": {
    "from": "+16155574615",  // SMS phone number
    "inReplyTo": "msg-123"   // For threading
  }
}
```

**Key Functions:**
- `loadSession()` → messages array
- `appendMessage(role, content, channel, metadata)` → write + return messageId
- `getContext(limit?)` → last N messages or full history
- `compactSession()` → (stub for now) summarize old messages when context grows large

**Compaction Strategy (future):**
- When session exceeds ~100k tokens, summarize messages older than 7 days
- Keep recent 50 messages verbatim
- Store summary as system message

---

### 2. Claude Code Process Manager (`lib/claude.js`)

**Responsibilities:**
- Spawn `claude` CLI subprocess for each agent turn
- Stream output, capture tool use
- Handle errors, timeouts
- Return assistant response

**Key Function:**
```javascript
async function runClaude({ 
  messages,           // Full conversation history
  workspace,          // Path to workspace dir
  systemPrompt,       // Additional system context (channel, metadata)
  timeout = 300000    // 5 min default
}) {
  // 1. Build prompt from messages
  // 2. Spawn: claude --dangerously-skip-permissions --cwd=workspace
  // 3. Stream stdin (conversation history)
  // 4. Capture stdout (response + tool use)
  // 5. Return { role: "assistant", content: "..." }
}
```

**Claude Code Invocation:**
```bash
claude \
  --dangerously-skip-permissions \
  --cwd=/home/node/.openclaw/workspace \
  --model=claude-opus-4 \
  --print
```

**System Prompt Injection:**
Prepend each turn with:
```
You are Wright, Mitchell's personal assistant.
Current time: 2026-03-16 16:00 UTC
Channel: sms
From: +16155574615

[Load AGENTS.md, SOUL.md, USER.md, etc. from workspace]
```

---

### 3. Multi-Channel Routing (`lib/channels.js`)

**Responsibilities:**
- Route incoming messages (web, SMS) to session
- Route outgoing responses back to origin channel
- Handle channel-specific formatting (SMS length limits, etc.)

**Input Flow:**
1. Message arrives via web UI or SMS webhook
2. `channels.handleIncoming(channel, content, metadata)`:
   - Append to session
   - Trigger Claude Code turn
   - Route response back to channel

**Output Flow:**
1. Claude Code returns response
2. `channels.sendReply(channel, content, metadata)`:
   - Web: WebSocket broadcast
   - SMS: Twilio API POST

**SMS Threading:**
- Track `inReplyTo` in metadata
- Store SMS message IDs for thread association

---

### 4. Cron Job Scheduler (`lib/cron.js`)

**Responsibilities:**
- Load jobs from `cron/jobs.json`
- Schedule periodic tasks (heartbeat, custom jobs)
- Trigger Claude Code turns for cron tasks

**Job Format:**
```json
{
  "id": "heartbeat",
  "schedule": "*/30 * * * *",  // Every 30 minutes
  "enabled": true,
  "prompt": "Read HEARTBEAT.md and follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.",
  "channel": "heartbeat"
}
```

**Key Functions:**
- `loadJobs()` → parse cron/jobs.json
- `scheduleJob(job)` → register with node-cron
- `runJob(job)` → trigger Claude Code turn, handle response

**Heartbeat Flow:**
1. Cron fires every 30 min
2. Trigger Claude Code with heartbeat prompt
3. If response !== "HEARTBEAT_OK", route to web/SMS

---

### 5. Context Window Management (`lib/context.js`)

**Responsibilities:**
- Track conversation token usage
- Decide when compaction is needed
- Summarize old messages (future)

**Stub Implementation:**
```javascript
function needsCompaction(messages) {
  return false; // Punt for now, Claude Opus has 200k context
}

async function compactMessages(messages) {
  // TODO: Summarize messages older than 7 days
  // Keep last 50 messages verbatim
  return messages;
}
```

---

## Web UI (`public/index.html`)

**Features:**
- Simple chat interface (message input, history display)
- WebSocket connection for real-time updates
- Show channel badges (web/SMS/heartbeat)
- Typing indicators

**Tech Stack:**
- Vanilla JS (no React/Vue)
- WebSocket for real-time
- Tailwind CSS for styling (CDN)

---

## Server (`server.js`)

**Responsibilities:**
- Express HTTP server
- WebSocket server for web UI
- Twilio SMS webhook endpoint
- Session orchestration (incoming → Claude → outgoing)

**Endpoints:**
- `GET /` → Serve web UI
- `POST /sms/webhook` → Twilio SMS webhook
- `WS /ws` → WebSocket for web chat
- `GET /health` → Health check

**Main Loop:**
```javascript
async function handleMessage(channel, content, metadata) {
  // 1. Append to session
  const messageId = await session.appendMessage('user', content, channel, metadata);
  
  // 2. Get context
  const messages = await session.getContext();
  
  // 3. Build system prompt
  const systemPrompt = buildSystemPrompt(channel, metadata);
  
  // 4. Run Claude Code
  const response = await claude.runClaude({ 
    messages, 
    workspace: '/home/node/.openclaw/workspace',
    systemPrompt 
  });
  
  // 5. Append response
  await session.appendMessage('assistant', response.content, channel, { inReplyTo: messageId });
  
  // 6. Route back to channel
  await channels.sendReply(channel, response.content, metadata);
}
```

---

## Migration from OpenClaw

### 1. Workspace
- Keep existing `~/.openclaw/workspace/` as-is
- Point MiniClaw to this directory
- No changes needed

### 2. Cron Jobs
- Export current OpenClaw cron jobs (list them manually)
- Rebuild in `cron/jobs.json`
- Key jobs: heartbeat, flight scanner, WhatsApp check

### 3. Credentials
- Copy secrets from OpenClaw to `miniclaw/secrets/`
- Format: `{ "TWILIO_ACCOUNT_SID": "...", ... }`

### 4. SMS Webhook
- Update Twilio webhook URL to point to MiniClaw
- Test in parallel before switching

### 5. Conversation History
- OpenClaw session history is internal; don't migrate
- Start fresh with `sessions/main.json`
- Claude Code will read workspace docs for continuity

---

## Implementation Plan

### Phase 1: Core Infrastructure
1. `lib/session.js` - Basic load/save, append
2. `lib/claude.js` - Spawn Claude Code subprocess, stream I/O
3. `server.js` - Express + basic web endpoint
4. Test: Manual message → Claude → response

### Phase 2: Multi-Channel Routing
1. `lib/channels.js` - SMS + web routing
2. SMS webhook endpoint
3. WebSocket for web UI
4. Test: Send SMS → Claude → reply

### Phase 3: Cron + Heartbeat
1. `lib/cron.js` - Job scheduler
2. `cron/jobs.json` - Heartbeat job
3. Test: Heartbeat fires, executes tasks

### Phase 4: Polish
1. Web UI improvements
2. Error handling, logging
3. Context compaction (future)

---

## Open Questions

1. **Claude Code API**: How to programmatically invoke Claude Code and capture structured output?
   - Likely: Spawn as subprocess, stream stdin/stdout
   - Need to test: Does Claude Code support conversation history input?

2. **Context Window**: What's the actual token limit before we need compaction?
   - Claude Opus: 200k context, should be fine for months

3. **Browser Automation**: How does Claude Code handle browser control?
   - Assume it "just works" via built-in tools

4. **Credentials**: How does Claude Code access secrets?
   - Pass via environment variables? Read from secrets/ dir?

5. **Error Recovery**: What happens if Claude Code crashes mid-turn?
   - Log, retry once, then fail gracefully

---

## Success Criteria

- ✅ Can send message via web UI, get Claude response
- ✅ Can send SMS, get reply
- ✅ Heartbeat fires every 30 min, executes HEARTBEAT.md tasks
- ✅ Conversation persists across restarts
- ✅ Workspace docs (AGENTS.md, SOUL.md) automatically loaded
- ✅ Browser automation works (Messenger, Uber)
- ✅ Costs ~$0/month (all via Max subscription)

---

## Non-Goals (for now)

- Multi-agent orchestration
- Advanced context pruning
- Voice channel support
- Approval system for elevated commands
- Model fallbacks
- Built-in tool ecosystem (use MCP instead)

---

## Tech Stack

- **Runtime**: Node.js (already installed)
- **HTTP Server**: Express
- **WebSocket**: `ws` package
- **Cron**: `node-cron` package
- **Claude**: `claude` CLI (via Max subscription)
- **SMS**: Twilio API
- **Browser**: Claude Code built-in

---

## Next Steps

1. Implement Phase 1 (core infrastructure)
2. Test Claude Code invocation manually
3. Build minimal web UI
4. Wire up SMS webhook
5. Add heartbeat cron
6. Test end-to-end
7. Migrate from OpenClaw

---

**Questions for Implementation:**
- How to structure conversation history for Claude Code input?
- What's the best way to stream Claude Code output?
- Should we use a database for session storage, or is JSON sufficient?
- How to handle concurrent requests (web + SMS at same time)?
