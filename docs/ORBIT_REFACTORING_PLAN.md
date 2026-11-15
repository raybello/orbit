# Orbit Refactoring Implementation Plan

**Based on Poteto-Mode Principles**  
**Generated**: 2026-11-14  
**Scope**: Desktop (primary), Server, Web apps  
**Approach**: Conservative - prove it works first

---

## Executive Summary

This plan addresses four critical architectural issues in the Orbit codebase:
1. **Unclear boundaries between layers** - Business logic mixed with UI/API/infrastructure
2. **Scattered state management** - State duplicated across store, DB, and memory
3. **Too much abstraction** - Wrappers and indirection that obscure intent
4. **Missing domain modeling** - Domain concepts as primitives instead of typed structures

Additionally: **1,201 comment lines** to audit (most explain WHAT, not WHY), **19% test coverage** to expand, and **312 exported server functions** to organize.

**Implementation strategy**: Subtract before you add. Remove abstractions, model the domain, establish boundaries, then build tests that verify behavior.

---

## Part 1: Current State Analysis

### 1.1 Architectural Pain Points

#### **Unclear Boundaries**

**Location**: `apps/server/src/routes.ts`

```typescript
// BEFORE: Business logic inside route handlers
function createBot(userId: string, b: { name: string; ... }) {
  // Avatar selection logic in route layer
  if (agentCount() >= env.maxBots) throw new UserError(`The team is full...`);
  
  const id = newId();
  const avatarShape = b.avatarShape || hashPick(id, SHAPES);
  const avatarColor = b.avatarColor || hashPick(id, COLORS);
  // ... database writes, engine assignment, screen allocation
}
```

**Problem**: Route handlers contain:
- Business rules (max bots check)
- Domain logic (avatar generation)
- Infrastructure (DB writes, engine assignment)
- No clear contracts between layers

**Files affected**: `routes.ts` (312 exported functions), `routes-computers.ts`, `routes-rooms.ts`, `routes-files.ts`, `routes-skills.ts`, `routes-calendar.ts`

#### **Scattered State**

**Location**: `apps/web/src/store.ts`

```typescript
// BEFORE: Business logic in Zustand store
export function activityPreview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

export function cardPreview(body: CardBody): string | null {
  if (body.status !== 'pending') return null;
  switch (body.card) {
    case 'approval': return body.title;
    case 'question': return body.question;
    // ... more business logic
  }
}
```

**Problem**: State management mixes with domain logic. State lives in three places:
1. `store.ts` (Zustand) - UI state + domain logic
2. `db.ts` (SQLite) - Persistent state
3. `live` object - Runtime state

No single source of truth for bot lifecycle, card workflow, or computer state.

**Files affected**: `store.ts`, `db.ts`, `store.js` (server), `computer-store.ts`

#### **Too Much Abstraction**

**Location**: `apps/desktop/src/stack-controller.ts`

```typescript
// BEFORE: Interface with optional methods and kind discrimination
export interface StackController {
  readonly kind?: StackKind;  // Discriminator
  readonly stackDir: string;
  state(): DesktopLocalStackState;
  webUrl(): string;
  token(): string | null;
  sessionSecret?(): string | null;  // Optional
  prepareEnvFile?(): string | null;  // Optional
  start(): Promise<DesktopLocalStackState>;
  stop(): Promise<DesktopLocalStackState>;
  abort(): void;
  dispose?(): void;  // Optional
  matchesDesiredStack(desiredUrl?: string): boolean | Promise<boolean>;
}
```

**Problem**: 
- Optional methods signal unclear contracts
- `kind` discrimination means callers branch on implementation
- `matchesDesiredStack` returns `boolean | Promise<boolean>` (sync vs async)
- Interface exists for two implementations (Docker, Native)

**Files affected**: `stack-controller.ts`, `local-stack.ts`, `native-stack.ts`, `main.ts`

#### **Missing Domain Models**

**Problem**: Core domain concepts expressed as primitives:

```typescript
// Bot lifecycle states scattered as strings
engine: 'primary' | 'managed' | null
status: 'running' | 'stopped' | 'error' | string

// Card workflow as status strings
status: 'pending' | 'approved' | 'denied' | 'cancelled'

// Computer states as loose objects
type ComputerState = { status: string; error?: string; ... }

// Voice call state scattered across multiple files
```

**What's missing**:
- Bot lifecycle state machine
- Card approval workflow model
- Computer provisioning flow
- Voice call session model
- Engine assignment logic

**Files affected**: `types.ts`, `engine.ts`, `computer.ts`, `voice.ts`, `store.ts`

---

### 1.2 Comment Audit

**Total**: 1,201 comment lines across Desktop, Server, Web

#### **Categories**:

1. **"What" comments** (70% - DELETE): Describe code that names itself
   ```typescript
   // Every bot is run by a Hermes agent.
   // The 'primary' engine is a Hermes gateway that already runs...
   ```

2. **"Why" comments** (20% - KEEP): Explain non-obvious constraints
   ```typescript
   // Closed by default (Teams): the conversation takes the full width until asked
   ```

3. **Dead/outdated comments** (10% - DELETE): Reference old code or wrong assumptions

#### **Action**: Remove 80% of comments (960 lines). Keep only non-obvious WHY.

---

### 1.3 Testing Gaps

**Current**: 39 test files / 205 source files = **19% coverage**

**Issues**:
- Tests likely implementation-focused (mocks, internal structure)
- Missing behavior tests (user scenarios, edge cases)
- No integration tests across boundaries
- Desktop app has minimal tests

**Target**: 60-80% coverage with behavior-focused tests

---

## Part 2: Refactoring Strategy

### Principles Applied

1. **Laziness Protocol**: Remove abstractions first, add only what's needed
2. **Foundational Thinking**: Start with core types and data structures
3. **Model the Domain**: Encode domain in state machines and typed models
4. **Boundary Discipline**: Guards at system boundaries, trust internal types
5. **Type System Discipline**: Make illegal states unrepresentable
6. **Minimize Reader Load**: Reduce layers, collapse one-caller wrappers
7. **Subtract Before You Add**: Remove dead code and weak abstractions first
8. **Test Behavior, Not Implementation**: Assert observable behavior
9. **Prove It Works**: Verify each step before the next

---

### 2.1 Phase 1: Foundation (Model the Domain)

**Goal**: Define core domain models as typed state machines and structures.

#### **Step 1.1: Bot Lifecycle State Machine**

**Create**: `apps/server/src/domain/bot-lifecycle.ts`

```typescript
// Bot lifecycle as a state machine
export type BotState =
  | { status: 'created'; botId: string }
  | { status: 'provisioning'; botId: string; engineKind: 'primary' | 'managed' }
  | { status: 'ready'; botId: string; engine: Engine; screen: Screen }
  | { status: 'running'; botId: string; engine: Engine; screen: Screen; turnId: string }
  | { status: 'error'; botId: string; error: Error; lastState: BotState };

export type BotEvent =
  | { type: 'provision-engine'; kind: 'primary' | 'managed' }
  | { type: 'engine-ready'; engine: Engine }
  | { type: 'screen-assigned'; screen: Screen }
  | { type: 'turn-started'; turnId: string }
  | { type: 'turn-finished' }
  | { type: 'error'; error: Error };

export function transition(state: BotState, event: BotEvent): BotState {
  switch (state.status) {
    case 'created':
      if (event.type === 'provision-engine') {
        return { status: 'provisioning', botId: state.botId, engineKind: event.kind };
      }
      break;
    
    case 'provisioning':
      if (event.type === 'engine-ready' && event.type === 'screen-assigned') {
        return { status: 'ready', botId: state.botId, engine: event.engine, screen: event.screen };
      }
      break;
    
    case 'ready':
      if (event.type === 'turn-started') {
        return { ...state, status: 'running', turnId: event.turnId };
      }
      break;
    
    case 'running':
      if (event.type === 'turn-finished') {
        const { turnId, ...rest } = state;
        return { ...rest, status: 'ready' };
      }
      break;
  }
  
  if (event.type === 'error') {
    return { status: 'error', botId: state.botId, error: event.error, lastState: state };
  }
  
  return state;
}
```

**Why**: Makes illegal transitions impossible. Removes scattered state checks.

#### **Step 1.2: Card Approval Workflow**

**Create**: `apps/server/src/domain/card-workflow.ts`

```typescript
// Card approval as a workflow model
export type CardState =
  | { status: 'pending'; cardId: string; body: CardBody; createdAt: number }
  | { status: 'approved'; cardId: string; approvedAt: number; approvedBy: string }
  | { status: 'denied'; cardId: string; deniedAt: number; deniedBy: string; reason?: string }
  | { status: 'expired'; cardId: string; expiredAt: number };

export type CardEvent =
  | { type: 'approve'; userId: string; timestamp: number }
  | { type: 'deny'; userId: string; reason?: string; timestamp: number }
  | { type: 'expire'; timestamp: number };

export function transitionCard(state: CardState, event: CardEvent): CardState {
  if (state.status !== 'pending') {
    return state;  // Terminal states don't transition
  }
  
  switch (event.type) {
    case 'approve':
      return { status: 'approved', cardId: state.cardId, approvedAt: event.timestamp, approvedBy: event.userId };
    
    case 'deny':
      return { status: 'denied', cardId: state.cardId, deniedAt: event.timestamp, deniedBy: event.userId, reason: event.reason };
    
    case 'expire':
      return { status: 'expired', cardId: state.cardId, expiredAt: event.timestamp };
  }
}
```

**Why**: Workflow encoded in types. Terminal states can't be re-approved.

#### **Step 1.3: Computer Provisioning Model**

**Create**: `apps/server/src/domain/computer-model.ts`

```typescript
// Computer provisioning as a typed model
export type ComputerStatus =
  | { kind: 'absent' }
  | { kind: 'provisioning'; orgoId: string; startedAt: number }
  | { kind: 'ready'; orgoId: string; screens: Screen[] }
  | { kind: 'suspended'; orgoId: string; suspendedAt: number; reason: string }
  | { kind: 'error'; error: string; failedAt: number };

export interface Screen {
  screenId: string;
  botId: string | null;  // null = available
  lastUsedAt: number;
}

export function canAssignScreen(computer: ComputerStatus): boolean {
  return computer.kind === 'ready' && computer.screens.some(s => s.botId === null);
}

export function assignScreen(computer: ComputerStatus, botId: string): ComputerStatus {
  if (computer.kind !== 'ready') {
    throw new Error(`Cannot assign screen: computer is ${computer.kind}`);
  }
  
  const available = computer.screens.find(s => s.botId === null);
  if (!available) {
    throw new Error('No available screens');
  }
  
  return {
    ...computer,
    screens: computer.screens.map(s =>
      s.screenId === available.screenId
        ? { ...s, botId, lastUsedAt: Date.now() }
        : s
    ),
  };
}
```

**Why**: Computer state modeled as discriminated union. Operations type-safe.

#### **Verification**:
```bash
# Create test file for each model
pnpm test -- bot-lifecycle.test.ts
pnpm test -- card-workflow.test.ts
pnpm test -- computer-model.test.ts
```

**Pass criteria**: All state transitions tested, illegal states rejected.

---

### 2.2 Phase 2: Establish Boundaries

**Goal**: Separate business logic from infrastructure, UI, and API layers.

#### **Step 2.1: Extract Business Logic from Routes**

**Before**: `apps/server/src/routes.ts` (1 file, 1000+ lines)

**After**: Split into layers

```
apps/server/src/
  domain/          # State machines, workflows (from Phase 1)
    bot-lifecycle.ts
    card-workflow.ts
    computer-model.ts
  
  core/            # Business logic (pure functions)
    bot-service.ts
    card-service.ts
    computer-service.ts
  
  infra/           # Database, external services
    bot-repository.ts
    computer-repository.ts
    engine-provider.ts
    orgo-client.ts
  
  api/             # HTTP handlers (thin)
    routes.ts       # Orchestration only
```

**Example - Bot Creation**:

```typescript
// AFTER: core/bot-service.ts (business logic)
import { transition, type BotState } from '../domain/bot-lifecycle';

export interface CreateBotInput {
  userId: string;
  name: string;
  label?: string;
  description?: string;
  mode?: 'personal' | 'teammate';
}

export interface CreateBotOutput {
  botId: string;
  state: BotState;
  avatar: { shape: string; color: string };
}

export function createBot(
  input: CreateBotInput,
  deps: {
    canAddBot: (userId: string) => boolean;
    generateId: () => string;
    pickAvatar: (id: string) => { shape: string; color: string };
  }
): CreateBotOutput {
  if (!deps.canAddBot(input.userId)) {
    throw new Error('Maximum bots reached for this user');
  }
  
  const botId = deps.generateId();
  const avatar = deps.pickAvatar(botId);
  const state: BotState = { status: 'created', botId };
  
  return { botId, state, avatar };
}
```

```typescript
// AFTER: api/routes.ts (thin orchestration)
import { createBot } from '../core/bot-service';
import { saveBotState } from '../infra/bot-repository';
import { canAddBot, generateBotId, selectAvatar } from '../infra/helpers';

api.post('/api/bots', requireUser, async (c) => {
  const userId = c.get('userId');
  const input = await c.req.json();
  
  // Business logic (pure function)
  const result = createBot(
    { userId, ...input },
    { canAddBot, generateId: generateBotId, pickAvatar: selectAvatar }
  );
  
  // Persistence (side effect)
  await saveBotState(result.botId, result.state);
  
  return c.json({ botId: result.botId, avatar: result.avatar });
});
```

**Why**:
- Business logic is testable without HTTP, DB, or external services
- Routes are thin orchestration
- Dependencies explicit (no hidden globals)

#### **Step 2.2: Clean UI/State Boundary**

**Before**: `apps/web/src/store.ts` has domain logic

```typescript
// BEFORE: Business logic in store
export function cardPreview(body: CardBody): string | null {
  if (body.status !== 'pending') return null;
  switch (body.card) {
    case 'approval': return body.title;
    case 'question': return body.question;
    // ...
  }
}
```

**After**: Extract to domain layer

```typescript
// AFTER: apps/web/src/domain/card-display.ts
export function cardPreview(body: CardBody): string | null {
  if (body.status !== 'pending') return null;
  
  switch (body.card) {
    case 'approval': return body.title;
    case 'question': return body.question;
    case 'connect': return `Connect ${body.toolkitName}`;
    case 'draft': return body.subject || `Draft ${body.channel} message`;
  }
}
```

```typescript
// AFTER: apps/web/src/store.ts (state only)
import { cardPreview } from './domain/card-display';

export const useStore = create<State>((set, get) => ({
  // State only - no business logic
  bots: [],
  live: {},
  selectedBotId: null,
  
  // Actions delegate to domain functions
  getCardPreview(body: CardBody) {
    return cardPreview(body);
  },
}));
```

**Why**: Store manages state. Domain layer owns logic. UI can't bypass rules.

#### **Verification**:
```bash
# Business logic tests (no DB, no HTTP)
pnpm test -- core/bot-service.test.ts

# Integration tests (full stack)
pnpm test -- api/routes.test.ts

# UI tests (no external dependencies)
pnpm test -- components/ChatView.test.tsx
```

---

### 2.3 Phase 3: Subtract Abstractions

**Goal**: Remove indirection that obscures intent. Collapse one-caller wrappers.

#### **Step 3.1: Simplify StackController**

**Before**: Interface with optional methods, kind discrimination

```typescript
// BEFORE: Abstract interface
export interface StackController {
  readonly kind?: StackKind;
  sessionSecret?(): string | null;
  prepareEnvFile?(): string | null;
  dispose?(): void;
  matchesDesiredStack(desiredUrl?: string): boolean | Promise<boolean>;
}

// Usage requires branching
if (stack.kind === 'docker') {
  await (stack as LocalStackController).someDockerMethod();
} else {
  (stack as NativeStackController).someNativeMethod();
}
```

**After**: Concrete types, explicit choice

```typescript
// AFTER: Discriminated union
export type StackController =
  | { kind: 'docker'; docker: DockerStack }
  | { kind: 'native'; native: NativeStack };

export interface DockerStack {
  stackDir: string;
  state(): StackState;
  start(): Promise<StackState>;
  stop(): Promise<StackState>;
  matchesImage(url: string): Promise<boolean>;
}

export interface NativeStack {
  stackDir: string;
  state(): StackState;
  start(): Promise<StackState>;
  stop(): Promise<StackState>;
  dispose(): void;
}

// Usage is type-safe pattern matching
switch (stack.kind) {
  case 'docker':
    await stack.docker.matchesImage(url);
    break;
  case 'native':
    stack.native.dispose();
    break;
}
```

**Why**: 
- No optional methods (each type has what it needs)
- No instanceof checks or type casts
- Exhaustive switching enforced by TypeScript

#### **Step 3.2: Collapse Helper Wrappers**

**Before**: Many small exported helpers

```typescript
// apps/server/src/engine.ts
export function primaryBotId(): string | null {
  return (db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get() as any)?.id ?? null;
}

export function engineKind(botId: string): EngineKind | null {
  const e = botRow(botId)?.engine;
  return e === 'primary' || e === 'managed' ? e : null;
}

const homeFor = (botId: string) => path.join(env.enginesDir, botId);
export const managedHome = homeFor;  // Wrapper of a wrapper
```

**After**: Inline or group by purpose

```typescript
// AFTER: Direct query where used (one caller)
const primaryBot = db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get();

// AFTER: Group related operations
export const EngineQueries = {
  primaryBotId(): string | null {
    return db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get()?.id ?? null;
  },
  
  managedHome(botId: string): string {
    return path.join(env.enginesDir, botId);
  },
} as const;
```

**Why**: 312 exports → ~80 exports. Less surface area, clearer grouping.

#### **Verification**:
```bash
# Ensure no regressions
pnpm typecheck
pnpm test
```

---

### 2.4 Phase 4: Comment Purge

**Goal**: Remove 80% of comments (960 lines). Keep only non-obvious WHY.

#### **Rules**:

1. **DELETE "What" comments**: Code that names itself doesn't need explanation
2. **KEEP "Why" comments**: Non-obvious constraints, workarounds, gotchas
3. **DELETE phase-narrating comments**: `// Phase 1: add cards`
4. **CONVERT to better names**: If you need a comment, the name is wrong

#### **Examples**:

```typescript
// BEFORE
/**
 * Every bot is run by a Hermes agent.
 *
 * - The 'primary' engine is a Hermes gateway that already runs on the computer (HERMES_URL, home
 *   HERMES_HOME_PRIMARY). It has its own life: messaging, memory, model. We only talk to its API
 *   server; we never write its config, restart it or stop it.
 * - A 'managed' engine is a Hermes home of our own under ENGINES_DIR/<botId> with its own
 *   `hermes gateway run`, started here and left running when this server exits.
 */
export type EngineKind = 'primary' | 'managed';
```

```typescript
// AFTER (comment deleted, domain model explains itself)
export type Engine =
  | { kind: 'primary'; url: string; home: string }  // Existing Hermes agent, never restarted
  | { kind: 'managed'; url: string; home: string; port: number };  // Our own process
```

```typescript
// BEFORE
// Closed by default (Teams): the conversation takes the full width until asked otherwise.
detailsOpen: lsGet(LS_DETAILS) === '1',
```

```typescript
// AFTER (KEEP - explains product decision)
// Closed by default (Teams): the conversation takes the full width until asked otherwise.
detailsOpen: lsGet(LS_DETAILS) === '1',
```

```typescript
// BEFORE
// ---------- small file helpers ----------

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
export function readDotenv(file: string): Record<string, string> { ... }
```

```typescript
// AFTER (comment deleted, function name + type signature explains itself)
export function readDotenv(file: string): Record<string, string> { ... }
```

#### **Process**:
1. Run: `grep -r "^\\s*//\|^\\s*/\\*" apps/{desktop,server,web}/src --include="*.ts" > comments.txt`
2. Review each file
3. Delete WHAT comments, keep WHY comments
4. Rename where comment was compensating for bad naming

#### **Verification**:
```bash
# Measure progress
before=$(git show HEAD:apps/server/src/engine.ts | grep -c "^\\s*//\|^\\s*/\\*")
after=$(grep -c "^\\s*//\|^\\s*/\\*" apps/server/src/engine.ts)
echo "Removed $((before - after)) comments from engine.ts"
```

**Target**: 1,201 → ~240 comments (80% reduction)

---

### 2.5 Phase 5: Type Safety Hardening

**Goal**: Eliminate `any`, strengthen boundaries with branded types, parse external data.

#### **Step 5.1: Remove `any` Types**

**Before**:
```typescript
const botRow = (botId: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;

export function toBot(r: any): Bot { ... }
```

**After**:
```typescript
interface BotRow {
  id: string;
  user_id: string;
  name: string;
  label: string;
  // ... all DB columns typed
}

const botRow = (botId: string) => 
  db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as BotRow | undefined;

export function toBot(r: BotRow): Bot { ... }
```

#### **Step 5.2: Brand Primitive IDs**

**Before**: String IDs everywhere, no type safety

```typescript
function getBot(id: string) { ... }
function getUser(id: string) { ... }

// Oops, swapped arguments
const bot = getBot(userId);  // Type system doesn't catch this
```

**After**: Branded types

```typescript
// packages/contracts/src/branded-types.ts
export type BotId = string & { readonly __brand: 'BotId' };
export type UserId = string & { readonly __brand: 'UserId' };
export type ScreenId = string & { readonly __brand: 'ScreenId' };

export const BotId = {
  parse(raw: string): BotId {
    if (!raw.startsWith('bot_')) throw new Error('Invalid BotId');
    return raw as BotId;
  },
  
  unsafe(raw: string): BotId {
    return raw as BotId;  // Internal use only
  },
};

// Usage
function getBot(id: BotId) { ... }
function getUser(id: UserId) { ... }

const bot = getBot(userId);  // ❌ Type error: UserId is not assignable to BotId
```

#### **Step 5.3: Parse External Data at Boundaries**

**Before**: Trust all inputs

```typescript
api.post('/api/bots', async (c) => {
  const input = await c.req.json();  // any
  createBot(input.name, input.label);  // No validation
});
```

**After**: Validate at boundary with Zod

```typescript
import { z } from 'zod';

const CreateBotSchema = z.object({
  name: z.string().min(1).max(50),
  label: z.string().max(30).optional(),
  description: z.string().max(500).optional(),
  mode: z.enum(['personal', 'teammate']).default('personal'),
});

api.post('/api/bots', requireUser, async (c) => {
  const raw = await c.req.json();
  const input = CreateBotSchema.parse(raw);  // Throws on invalid input
  
  const result = createBot({ userId: c.get('userId'), ...input });
  return c.json(result);
});
```

**Why**: Invalid data rejected at the boundary. Internal code trusts types.

#### **Verification**:
```bash
# Type check passes with no `any`
pnpm typecheck --strict

# Test boundary validation
pnpm test -- api/routes.test.ts
```

---

### 2.6 Phase 6: Testing Strategy

**Goal**: 60-80% coverage with behavior-focused tests.

#### **Testing Pyramid**:

```
        /\
       /  \  E2E (10%)
      /────\  Integration (30%)
     /──────\  Unit (60%)
    /────────\
```

#### **Step 6.1: Domain Model Tests (Unit)**

Test state machines and workflows in isolation.

```typescript
// apps/server/src/domain/__tests__/bot-lifecycle.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { transition, type BotState } from '../bot-lifecycle';

describe('Bot Lifecycle', () => {
  test('created → provisioning on provision-engine', () => {
    const state: BotState = { status: 'created', botId: 'bot_123' };
    const next = transition(state, { type: 'provision-engine', kind: 'managed' });
    
    assert.strictEqual(next.status, 'provisioning');
    assert.strictEqual(next.engineKind, 'managed');
  });
  
  test('cannot transition from ready to error without error event', () => {
    const state: BotState = { status: 'ready', botId: 'bot_123', engine: {...}, screen: {...} };
    const next = transition(state, { type: 'turn-started', turnId: 'turn_1' });
    
    assert.strictEqual(next.status, 'running');  // Valid transition
  });
  
  test('error event from any state moves to error', () => {
    const state: BotState = { status: 'provisioning', botId: 'bot_123', engineKind: 'managed' };
    const next = transition(state, { type: 'error', error: new Error('Failed') });
    
    assert.strictEqual(next.status, 'error');
    assert.strictEqual(next.lastState.status, 'provisioning');
  });
});
```

**Target**: 100% coverage of domain models (state machines, workflows)

#### **Step 6.2: Business Logic Tests (Unit)**

Test core services with mocked dependencies.

```typescript
// apps/server/src/core/__tests__/bot-service.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createBot } from '../bot-service';

describe('Bot Service', () => {
  test('creates bot with generated ID and avatar', () => {
    const result = createBot(
      { userId: 'user_1', name: 'TestBot' },
      {
        canAddBot: () => true,
        generateId: () => 'bot_123',
        pickAvatar: () => ({ shape: 'blob', color: 'blue' }),
      }
    );
    
    assert.strictEqual(result.botId, 'bot_123');
    assert.strictEqual(result.avatar.shape, 'blob');
    assert.strictEqual(result.state.status, 'created');
  });
  
  test('throws when max bots reached', () => {
    assert.throws(
      () => createBot(
        { userId: 'user_1', name: 'TestBot' },
        {
          canAddBot: () => false,  // Max reached
          generateId: () => 'bot_123',
          pickAvatar: () => ({ shape: 'blob', color: 'blue' }),
        }
      ),
      /Maximum bots reached/
    );
  });
});
```

**Target**: 80%+ coverage of core services

#### **Step 6.3: Integration Tests**

Test full request/response cycles with real DB (in-memory SQLite).

```typescript
// apps/server/src/api/__tests__/routes.test.ts
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { app } from '../app';

describe('POST /api/bots', () => {
  beforeEach(() => {
    // Reset DB to clean state
    db.exec('DELETE FROM bots');
  });
  
  test('creates bot and returns ID', async () => {
    const res = await app.request('/api/bots', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ name: 'TestBot', mode: 'personal' }),
    });
    
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.botId.startsWith('bot_'));
    assert.ok(data.avatar.shape);
  });
  
  test('rejects invalid name', async () => {
    const res = await app.request('/api/bots', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ name: '' }),  // Empty name
    });
    
    assert.strictEqual(res.status, 400);
  });
});
```

**Target**: All API routes covered with happy path + error cases

#### **Step 6.4: Component Tests (UI)**

Test React components with Testing Library (behavior-focused).

```typescript
// apps/web/src/components/__tests__/ChatView.test.tsx
import { describe, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatView } from '../ChatView';

describe('ChatView', () => {
  test('shows empty state when no bot selected', () => {
    render(<ChatView />, { wrapper: StoreProvider });
    
    expect(screen.getByText(/no bot selected/i)).toBeInTheDocument();
  });
  
  test('shows transcript when bot selected', () => {
    const store = createMockStore({
      bots: [{ id: 'bot_1', name: 'TestBot', ... }],
      selectedBotId: 'bot_1',
      transcripts: { bot_1: { rows: [...] } },
    });
    
    render(<ChatView />, { wrapper: () => <StoreProvider value={store} /> });
    
    expect(screen.getByText('TestBot')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();  // Composer
  });
});
```

**Target**: All user-facing components covered

#### **Step 6.5: E2E Tests (Desktop)**

Test full user flows with Playwright.

```typescript
// apps/desktop/e2e/first-run.spec.ts
import { test, expect } from '@playwright/test';

test('first run setup flow', async ({ page }) => {
  await page.goto('app://orbit');
  
  await expect(page.getByText('Welcome to Orbit')).toBeVisible();
  
  await page.getByLabel('Server URL').fill('https://orbit.example.com');
  await page.getByRole('button', { name: 'Connect' }).click();
  
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 10000 });
});
```

**Target**: Critical paths only (setup, login, create bot, send message)

---

## Part 3: Implementation Sequence

### 3.1 Sequencing Strategy

**Principle**: Sequence work into verifiable units. Verify each before the next.

```
Phase 1: Foundation (Domain Models)
  ├─ Step 1.1: Bot Lifecycle ✓ Test → Commit
  ├─ Step 1.2: Card Workflow ✓ Test → Commit
  └─ Step 1.3: Computer Model ✓ Test → Commit

Phase 2: Boundaries
  ├─ Step 2.1: Extract Bot Service ✓ Test → Commit
  ├─ Step 2.2: Extract Card Service ✓ Test → Commit
  ├─ Step 2.3: Extract Computer Service ✓ Test → Commit
  └─ Step 2.4: Split Routes ✓ Test → Commit

Phase 3: Subtract
  ├─ Step 3.1: Simplify StackController ✓ Test → Commit
  └─ Step 3.2: Collapse Helpers ✓ Test → Commit

Phase 4: Comments
  └─ One file at a time ✓ Review → Commit

Phase 5: Types
  ├─ Step 5.1: Remove `any` ✓ Typecheck → Commit
  ├─ Step 5.2: Brand IDs ✓ Test → Commit
  └─ Step 5.3: Boundary Validation ✓ Test → Commit

Phase 6: Tests
  ├─ Domain tests ✓ 100% coverage
  ├─ Service tests ✓ 80% coverage
  ├─ API tests ✓ All routes
  ├─ Component tests ✓ Critical paths
  └─ E2E tests ✓ Happy paths
```

### 3.2 Verification Checkpoints

After each commit:

```bash
# Type safety
pnpm typecheck

# Tests pass
pnpm test

# No regressions
pnpm build
pnpm dev  # Smoke test

# Coverage trend
pnpm test --coverage
```

### 3.3 Rollback Strategy

Each phase is independent. If a phase introduces bugs:

1. **Revert the phase**: `git revert <commit-range>`
2. **Keep prior phases**: Earlier work remains
3. **Fix and retry**: Address the issue, reapply

---

## Part 4: Before/After Patterns

### Pattern 1: Scattered State → State Machine

**Before**:
```typescript
// State scattered across multiple files
const bot = { engine: 'managed', screen: null, status: 'provisioning' };
if (bot.engine === 'managed' && bot.screen !== null) {
  // Ready?
}
```

**After**:
```typescript
// State as discriminated union
const bot: BotState = { status: 'provisioning', engineKind: 'managed' };

if (bot.status === 'ready') {
  bot.screen;  // TypeScript knows this exists
}
```

### Pattern 2: Business Logic in Routes → Service Layer

**Before**:
```typescript
api.post('/api/bots', async (c) => {
  const name = c.req.json().name;
  if (agentCount() >= MAX) throw new Error('Full');
  const id = newId();
  db.prepare('INSERT INTO bots...').run(id, name);
  assignEngine(id);
  return c.json({ id });
});
```

**After**:
```typescript
// Service (testable, pure)
export function createBot(input, deps) {
  if (!deps.canAdd()) throw new Error('Full');
  const id = deps.generateId();
  return { id, state: { status: 'created', botId: id } };
}

// Route (thin orchestration)
api.post('/api/bots', async (c) => {
  const input = CreateBotSchema.parse(await c.req.json());
  const result = createBot(input, { canAdd: () => agentCount() < MAX, generateId: newId });
  await saveBotState(result.id, result.state);
  return c.json(result);
});
```

### Pattern 3: Optional Interface Methods → Discriminated Union

**Before**:
```typescript
interface Stack {
  kind?: string;
  dispose?(): void;
}

if (stack.dispose) stack.dispose();  // Weak
```

**After**:
```typescript
type Stack = { kind: 'docker' } | { kind: 'native'; dispose(): void };

if (stack.kind === 'native') {
  stack.dispose();  // Type-safe
}
```

### Pattern 4: `any` Types → Branded Types

**Before**:
```typescript
function getBot(id: string) { ... }
getBot(userId);  // Oops, wrong ID
```

**After**:
```typescript
type BotId = string & { __brand: 'BotId' };
function getBot(id: BotId) { ... }
getBot(userId);  // ❌ Type error
```

### Pattern 5: Validation Anywhere → Boundary Parsing

**Before**:
```typescript
function createBot(name: string) {
  if (!name || name.length > 50) throw new Error('Invalid');  // Validation scattered
}
```

**After**:
```typescript
// Boundary
const input = CreateBotSchema.parse(raw);  // Validated once

// Core
function createBot(input: CreateBotInput) {
  // Input already validated, trust it
}
```

---

## Part 5: Migration Checklist

### For Each File:

- [ ] Read the file completely
- [ ] Identify domain concepts (state machines? workflows?)
- [ ] Extract business logic to `core/` or `domain/`
- [ ] Move infrastructure to `infra/`
- [ ] Remove `any` types, add type annotations
- [ ] Delete WHAT comments, keep WHY comments
- [ ] Write behavior tests (not implementation tests)
- [ ] Verify: `pnpm typecheck && pnpm test`
- [ ] Commit with clear message

### Desktop-Specific:

- [ ] `main.ts`: Extract stack selection logic
- [ ] `stack-controller.ts`: Convert to discriminated union
- [ ] `local-stack.ts`, `native-stack.ts`: Separate implementations
- [ ] `hermes-setup.ts`: Extract domain model for Hermes detection
- [ ] `docker-move.ts`: State machine for Docker data migration

### Server-Specific:

- [ ] `routes.ts`: Split into `api/`, `core/`, `infra/`
- [ ] `engine.ts`: Bot lifecycle state machine
- [ ] `computer.ts`: Computer provisioning model
- [ ] `store.ts`: Separate domain logic from DB operations
- [ ] `db.ts`: Type all queries, remove `any`
- [ ] `mcp.ts`: Boundary validation for MCP tools

### Web-Specific:

- [ ] `store.ts`: Extract domain logic to `domain/`
- [ ] `ChatView.tsx`: Delegate logic to hooks or domain functions
- [ ] `Composer.tsx`: Validation logic to domain layer
- [ ] `ComputerViewer.tsx`: State management cleanup

### Shared Packages:

- [ ] `contracts/`: Add branded types, validation schemas
- [ ] `logger/`: No changes needed (already clean)
- [ ] `ui-tokens/`: No changes needed

---

## Part 6: Success Metrics

### Code Quality

- **Comments**: 1,201 → ~240 (80% reduction)
- **Exports**: 312 → ~80 (75% reduction in server)
- **`any` types**: ~150 → 0
- **Cyclomatic complexity**: Avg 8 → Avg 4 (per function)

### Testing

- **Coverage**: 19% → 60-80%
- **Test count**: 39 files → 120+ files
- **Test type distribution**:
  - Unit: 60%
  - Integration: 30%
  - E2E: 10%

### Maintainability

- **Mean time to understand**: Subjective, target 50% reduction
- **Bug fix time**: Track before/after (expect 30% faster)
- **Onboarding time**: New developer productive in 2 days vs 5 days

### Type Safety

- **Strict mode**: Enabled
- **Branded types**: BotId, UserId, ScreenId, RoutineId
- **Boundary validation**: 100% of API routes

---

## Part 7: Risk Mitigation

### Risks & Mitigations

1. **Risk**: Breaking existing functionality
   - **Mitigation**: Small commits, verify each step, comprehensive tests

2. **Risk**: Merge conflicts during long refactor
   - **Mitigation**: One phase at a time, rebase frequently

3. **Risk**: Team disagreement on approach
   - **Mitigation**: Review this plan first, align on principles

4. **Risk**: Incomplete refactor (abandoned midway)
   - **Mitigation**: Each phase delivers value independently

5. **Risk**: Performance regression
   - **Mitigation**: Benchmark critical paths before/after

---

## Part 8: Next Steps

### Immediate Actions

1. **Review this plan** with team
2. **Set up test infrastructure** (Vitest, Testing Library, Playwright)
3. **Create feature branch**: `refactor/poteto-mode-foundation`
4. **Start Phase 1, Step 1.1**: Bot Lifecycle state machine

### Timeline Estimate (Conservative)

- **Phase 1 (Domain Models)**: 1 week
- **Phase 2 (Boundaries)**: 2 weeks
- **Phase 3 (Subtract)**: 1 week
- **Phase 4 (Comments)**: 1 week
- **Phase 5 (Types)**: 1 week
- **Phase 6 (Tests)**: 2 weeks

**Total**: 8 weeks for complete refactor

### Incremental Delivery

Don't wait 8 weeks. Ship after each phase:

- After Phase 1: Domain models usable
- After Phase 2: Clean architecture visible
- After Phase 3: Reduced complexity
- After Phase 4: Readable codebase
- After Phase 5: Type-safe
- After Phase 6: Well-tested

---

## Appendix A: Key Principles Reference

### Laziness Protocol
Remove abstractions, minimize diff size. Three similar lines > premature abstraction.

### Model the Domain
Encode domain in structures (state machines, typed models, registries) not conditionals.

### Boundary Discipline
Guards at system boundaries (API, DB, UI). Internal code trusts types.

### Minimize Reader Load
Count layers and hidden state. Collapse one-caller wrappers. Shrink mutable scope.

### Subtract Before You Add
Remove dead weight first, then build on simpler base.

### Test Behavior, Not Implementation
Assert observable behavior. Tests survive refactors.

### Prove It Works
Verify against real artifact before declaring done.

### No Comments Rule
Keep only non-obvious WHY. Delete WHAT. Names explain themselves.

---

## Appendix B: File Organization (After)

```
apps/
  desktop/
    src/
      domain/          # Desktop-specific domain models
      core/            # Business logic
      infra/           # Electron, Docker, file system
      ui/              # Windows, menus, IPC
      main.ts          # Thin orchestration
  
  server/
    src/
      domain/          # State machines, workflows
        bot-lifecycle.ts
        card-workflow.ts
        computer-model.ts
        engine-model.ts
        voice-session.ts
      
      core/            # Business logic (pure functions)
        bot-service.ts
        card-service.ts
        computer-service.ts
        engine-service.ts
      
      infra/           # Database, external services
        bot-repository.ts
        computer-repository.ts
        orgo-client.ts
        composio-client.ts
        db.ts
      
      api/             # HTTP handlers (thin)
        routes.ts
        routes-bots.ts
        routes-computers.ts
        middleware.ts
      
      index.ts         # App setup
  
  web/
    src/
      domain/          # UI domain logic
        card-display.ts
        activity-feed.ts
        transcript-utils.ts
      
      components/      # React components
      hooks/           # React hooks
      store.ts         # Zustand (state only)
      main.tsx

packages/
  contracts/
    src/
      types.ts         # Shared types
      branded-types.ts # BotId, UserId, etc.
      schemas.ts       # Zod validation schemas
```

---

## Appendix C: Detailed Examples

### Example 1: Bot Creation Flow (Full Stack)

**Before**: Logic scattered across routes, engine, computer, store

**After**: Clear layers

```typescript
// 1. API Layer (boundary)
// apps/server/src/api/routes-bots.ts
import { CreateBotSchema } from '@orbit/contracts/schemas';
import { createBot } from '../core/bot-service';
import { saveBotState, saveAvatar } from '../infra/bot-repository';
import { provisionEngine } from '../core/engine-service';

api.post('/api/bots', requireUser, async (c) => {
  const userId = c.get('userId');
  const raw = await c.req.json();
  
  // Parse and validate at boundary
  const input = CreateBotSchema.parse(raw);
  
  // Business logic
  const bot = createBot({ userId, ...input });
  
  // Persistence
  await saveBotState(bot.id, bot.state);
  await saveAvatar(bot.id, bot.avatar);
  
  // Start provisioning (async)
  provisionEngine(bot.id).catch(err => log.error('Engine provision failed', err));
  
  return c.json({ botId: bot.id, avatar: bot.avatar });
});
```

```typescript
// 2. Core Layer (business logic)
// apps/server/src/core/bot-service.ts
import { transition, type BotState } from '../domain/bot-lifecycle';
import type { BotId } from '@orbit/contracts';

export function createBot(input: CreateBotInput): CreateBotOutput {
  // Business rule: Check capacity
  if (!canAddBot(input.userId)) {
    throw new Error('Maximum bots reached');
  }
  
  // Generate identity
  const botId = generateBotId();
  const avatar = selectAvatar(botId);
  
  // Initial state
  const state: BotState = { status: 'created', botId };
  
  return { botId, state, avatar };
}
```

```typescript
// 3. Domain Layer (state machine)
// apps/server/src/domain/bot-lifecycle.ts
export type BotState =
  | { status: 'created'; botId: BotId }
  | { status: 'provisioning'; botId: BotId; engineKind: EngineKind }
  | { status: 'ready'; botId: BotId; engine: Engine; screen: Screen }
  | { status: 'running'; botId: BotId; engine: Engine; screen: Screen; turnId: string }
  | { status: 'error'; botId: BotId; error: Error };

export function transition(state: BotState, event: BotEvent): BotState {
  // Pure state transitions
}
```

```typescript
// 4. Infra Layer (persistence)
// apps/server/src/infra/bot-repository.ts
export async function saveBotState(botId: BotId, state: BotState): Promise<void> {
  const row = serializeState(state);
  db.prepare('INSERT INTO bots (...) VALUES (...)').run(row);
}
```

**Result**: Each layer has one job. Business logic testable without DB/HTTP.

---

### Example 2: Card Approval Flow

**Before**: Status strings, scattered validation

**After**: Workflow model

```typescript
// Domain
// apps/server/src/domain/card-workflow.ts
export type CardState =
  | { status: 'pending'; cardId: string; body: CardBody }
  | { status: 'approved'; cardId: string; approvedAt: number; approvedBy: UserId }
  | { status: 'denied'; cardId: string; deniedAt: number; deniedBy: UserId }
  | { status: 'expired'; cardId: string; expiredAt: number };

export function approveCard(state: CardState, userId: UserId, timestamp: number): CardState {
  if (state.status !== 'pending') {
    throw new Error(`Cannot approve: card is ${state.status}`);
  }
  
  return { status: 'approved', cardId: state.cardId, approvedAt: timestamp, approvedBy: userId };
}
```

```typescript
// API
// apps/server/src/api/routes-approvals.ts
api.post('/api/approvals/:id/approve', requireUser, async (c) => {
  const cardId = c.req.param('id');
  const userId = c.get('userId');
  
  const state = await loadCardState(cardId);
  const newState = approveCard(state, userId, Date.now());
  await saveCardState(cardId, newState);
  
  // Execute the approved action
  await executeApproval(newState);
  
  return c.json({ status: 'approved' });
});
```

**Result**: Impossible to approve a denied card. State transitions type-safe.

---

## Conclusion

This refactoring plan transforms Orbit from a codebase with scattered concerns and unclear boundaries into a well-architected application with:

- **Clear domain models** (state machines for bot lifecycle, card workflow, computer provisioning)
- **Strict boundaries** (API, core, domain, infra layers)
- **Type safety** (branded IDs, boundary validation, no `any`)
- **Minimal abstraction** (deleted 75% of helpers, simplified interfaces)
- **Readable code** (80% fewer comments, clear naming)
- **High test coverage** (60-80%, behavior-focused)

Each phase delivers independent value. Start with Phase 1 (domain models) and verify each step.

**Conservative approach**: Prove it works at each checkpoint. Zero tolerance for introduced bugs.

---

**End of Implementation Plan**
