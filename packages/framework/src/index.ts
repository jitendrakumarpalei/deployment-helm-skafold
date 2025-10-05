import { randomUUID } from 'crypto';

export type ActionType =
  | 'llm_call'
  | 'tool_use'
  | 'evaluation'
  | 'validation'
  | 'synthesis'
  | string;

export interface BillingEventInput {
  stepName: string;
  actionType: ActionType;
  unitCost?: number;
  quantity?: number;
  total?: number;
  metadata?: Record<string, unknown>;
  status?: 'success' | 'error';
}

export interface BillingEvent extends BillingEventInput {
  unitCost: number;
  quantity: number;
  total: number;
  metadata: Record<string, unknown>;
  status: 'success' | 'error';
}

export interface BillingInvoice {
  currency: string;
  total: number;
  lineItems: BillingEvent[];
}

export class BillingManager {
  private readonly lineItems: BillingEvent[] = [];
  private subtotal = 0;
  readonly currency = 'USD';

  record(input: BillingEventInput): BillingEvent {
    const unitCost = sanitizeNumber(input.unitCost, 0);
    const quantity = sanitizeNumber(input.quantity, 1);
    const metadata = { ...(input.metadata ?? {}) };
    const total = sanitizeNumber(
      input.total ?? unitCost * quantity,
      unitCost * quantity
    );
    const event: BillingEvent = {
      stepName: input.stepName,
      actionType: input.actionType,
      unitCost,
      quantity,
      total,
      metadata,
      status: input.status ?? 'success',
    };
    this.lineItems.push(event);
    this.subtotal += total;
    return event;
  }

  getLineItems(): BillingEvent[] {
    return [...this.lineItems];
  }

  getSubtotal(): number {
    return Number(this.subtotal.toFixed(6));
  }

  generateInvoice(): BillingInvoice {
    return {
      currency: this.currency,
      total: this.getSubtotal(),
      lineItems: this.getLineItems(),
    };
  }
}

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly prefix: string,
    private readonly context: Record<string, unknown> = {}
  ) {}

  debug(message: string, details: Record<string, unknown> = {}): void {
    console.debug(this.format('DEBUG', message), {
      ...this.context,
      ...details,
    });
  }

  info(message: string, details: Record<string, unknown> = {}): void {
    console.info(this.format('INFO', message), {
      ...this.context,
      ...details,
    });
  }

  warn(message: string, details: Record<string, unknown> = {}): void {
    console.warn(this.format('WARN', message), {
      ...this.context,
      ...details,
    });
  }

  error(message: string, details: Record<string, unknown> = {}): void {
    console.error(this.format('ERROR', message), {
      ...this.context,
      ...details,
    });
  }

  child(context: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.prefix, { ...this.context, ...context });
  }

  private format(level: string, message: string): string {
    return `[${level}] [${this.prefix}] ${message}`;
  }
}

export function createConsoleLogger(
  prefix: string,
  context: Record<string, unknown> = {}
): Logger {
  return new ConsoleLogger(prefix, context);
}

export interface StepRuntime {
  traceId: string;
  parentTraceId: string;
  logger: Logger;
  recordMetadata: (data: Record<string, unknown>) => void;
  setQuantity: (value: number) => void;
  setUnitCost: (value: number) => void;
}

export interface StepFinalizeInput {
  result?: unknown;
  error?: unknown;
  durationMs: number;
  defaultEvent: BillingEventInput;
}

export interface StepOptions {
  name: string;
  actionType: ActionType;
  unitCost?: number;
  quantity?: number;
  metadata?: Record<string, unknown>;
  costCalculator?: (details: {
    unitCost: number;
    quantity: number;
    metadata: Record<string, unknown>;
    durationMs: number;
  }) => number;
  finalizeBilling?: (input: StepFinalizeInput) => BillingEventInput | void;
  billOnError?: boolean;
}

export type StepFunction = <TResult>(
  options: StepOptions,
  workFn: (runtime: StepRuntime) => Promise<TResult>
) => Promise<TResult>;

export interface AgentContext {
  traceId: string;
  billingManager: BillingManager;
  logger: Logger;
  metadata?: Record<string, unknown>;
}

export interface AgentInvokeOptions {
  traceId?: string;
  metadata?: Record<string, unknown>;
  logger?: Logger;
}

export interface AgentRunResult<TResult> {
  output: TResult;
  invoice: BillingInvoice;
  traceId: string;
  startedAt: Date;
  durationMs: number;
}

export type AgentFn<TInput, TResult> = (
  step: StepFunction,
  input: TInput,
  context: AgentContext
) => Promise<TResult>;

export class AgentExecutionError extends Error {
  readonly agentName: string;
  readonly traceId: string;
  readonly invoice: BillingInvoice;
  readonly originalError: unknown;

  constructor(
    agentName: string,
    traceId: string,
    originalError: unknown,
    invoice: BillingInvoice
  ) {
    super(`Agent "${agentName}" failed (trace ${traceId})`);
    this.agentName = agentName;
    this.traceId = traceId;
    this.invoice = invoice;
    this.originalError = originalError;
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack;
    }
  }
}

interface StepFactoryArgs {
  rootTraceId: string;
  billingManager: BillingManager;
  logger: Logger;
}

function createStep({
  rootTraceId,
  billingManager,
  logger,
}: StepFactoryArgs): StepFunction {
  return async function step<TResult>(
    options: StepOptions,
    workFn: (runtime: StepRuntime) => Promise<TResult>
  ): Promise<TResult> {
    const start = Date.now();
    const childTraceId = `${rootTraceId}:${slugify(options.name)}:${start.toString(36)}`;
    const stepLogger = logger.child({ step: options.name, traceId: childTraceId });
    const metadata: Record<string, unknown> = {
      ...(options.metadata ?? {}),
      traceId: childTraceId,
    };
    let quantity = sanitizeNumber(options.quantity, 1);
    let unitCost = sanitizeNumber(options.unitCost, 0);

    const runtime: StepRuntime = {
      traceId: childTraceId,
      parentTraceId: rootTraceId,
      logger: stepLogger,
      recordMetadata: (data) => {
        Object.assign(metadata, data);
      },
      setQuantity: (value) => {
        quantity = sanitizeNumber(value, quantity);
      },
      setUnitCost: (value) => {
        unitCost = sanitizeNumber(value, unitCost);
      },
    };

    stepLogger.info('start', {
      actionType: options.actionType,
      unitCost,
      quantity,
    });

    try {
      const result = await workFn(runtime);
      const durationMs = Date.now() - start;
      metadata.durationMs = durationMs;

      const defaultEvent: BillingEventInput = buildBillingEvent(
        options,
        metadata,
        unitCost,
        quantity,
        durationMs
      );
      const customEvent = options.finalizeBilling?.({
        result,
        durationMs,
        defaultEvent,
      });
      const billingEvent = billingManager.record(customEvent ?? defaultEvent);

      stepLogger.info('complete', {
        durationMs,
        total: billingEvent.total,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - start;
      metadata.durationMs = durationMs;
      metadata.error = serializeError(error);
      stepLogger.error('failed', {
        durationMs,
        error: metadata.error,
      });

      if (options.billOnError ?? true) {
        const defaultEvent: BillingEventInput = buildBillingEvent(
          { ...options, metadata },
          metadata,
          unitCost,
          quantity,
          durationMs,
          'error'
        );
        const customEvent = options.finalizeBilling?.({
          error,
          durationMs,
          defaultEvent,
        });
        billingManager.record(customEvent ?? defaultEvent);
      }

      throw error;
    }
  };
}

function buildBillingEvent(
  options: StepOptions,
  metadata: Record<string, unknown>,
  unitCost: number,
  quantity: number,
  durationMs: number,
  status: 'success' | 'error' = 'success'
): BillingEventInput {
  const derivedMetadata = { ...metadata };
  const baseEvent: BillingEventInput = {
    stepName: options.name,
    actionType: options.actionType,
    unitCost,
    quantity,
    metadata: derivedMetadata,
    status,
  };
  const total = options.costCalculator
    ? options.costCalculator({ unitCost, quantity, metadata: derivedMetadata, durationMs })
    : unitCost * quantity;
  baseEvent.total = total;
  return baseEvent;
}

export function createAgent<TInput, TResult>(
  name: string,
  agentFn: AgentFn<TInput, TResult>
) {
  const agentName = name;

  return {
    name: agentName,
    async invoke(
      input: TInput,
      options: AgentInvokeOptions = {}
    ): Promise<AgentRunResult<TResult>> {
      const traceId = options.traceId ?? generateTraceId();
      const billingManager = new BillingManager();
      const baseLogger = (options.logger ?? createConsoleLogger(agentName)).child({
        traceId,
        agent: agentName,
      });
      const startedAt = new Date();

      baseLogger.info('run.start', {
        inputPreview: summarizeInput(input),
      });

      const step = createStep({
        rootTraceId: traceId,
        billingManager,
        logger: baseLogger,
      });

      const context: AgentContext = {
        traceId,
        billingManager,
        logger: baseLogger,
        metadata: options.metadata,
      };

      try {
        const output = await agentFn(step, input, context);
        const invoice = billingManager.generateInvoice();
        const durationMs = Date.now() - startedAt.getTime();
        baseLogger.info('run.success', {
          durationMs,
          total: invoice.total,
        });
        return {
          output,
          invoice,
          traceId,
          startedAt,
          durationMs,
        };
      } catch (error) {
        const invoice = billingManager.generateInvoice();
        const durationMs = Date.now() - startedAt.getTime();
        baseLogger.error('run.error', {
          durationMs,
          error: serializeError(error),
        });
        throw new AgentExecutionError(agentName, traceId, error, invoice);
      }
    },
  };
}

interface McpExecutionContext {
  traceId: string;
  parentTraceId: string;
  logger: Logger;
  headers: Record<string, string>;
}

export interface McpExecutionResult<TResult = unknown> {
  result: TResult;
  metadata?: Record<string, unknown>;
  unitCost?: number;
  quantity?: number;
}

export interface McpServerDefinition<TInput = unknown, TResult = unknown> {
  name: string;
  description?: string;
  defaultUnitCost?: number;
  execute: (
    input: TInput,
    context: McpExecutionContext
  ) => Promise<McpExecutionResult<TResult>>;
}

const mcpRegistry = new Map<string, McpServerDefinition<any, any>>();

export const McpRegistry = {
  register<TInput, TResult>(definition: McpServerDefinition<TInput, TResult>): void {
    mcpRegistry.set(definition.name, definition);
  },
  unregister(name: string): void {
    mcpRegistry.delete(name);
  },
  get<TInput, TResult>(name: string): McpServerDefinition<TInput, TResult> {
    const server = mcpRegistry.get(name);
    if (!server) {
      throw new Error(`MCP server "${name}" is not registered`);
    }
    return server;
  },
  list(): McpServerDefinition<any, any>[] {
    return Array.from(mcpRegistry.values());
  },
};

export interface McpToolInvokeOptions extends Partial<StepOptions> {
  headers?: Record<string, string>;
}

export function createMcpTool<TInput, TResult>(name: string) {
  return async function invokeMcpTool(
    step: StepFunction,
    input: TInput,
    options: McpToolInvokeOptions = {}
  ): Promise<McpExecutionResult<TResult>> {
    const server = McpRegistry.get<TInput, TResult>(name);
    const stepName = options.name ?? `${name} tool call`;
    const actionType = options.actionType ?? 'tool_use';

    return step(
      {
        ...options,
        name: stepName,
        actionType,
        unitCost: options.unitCost ?? server.defaultUnitCost ?? 0,
        metadata: {
          ...(options.metadata ?? {}),
          mcpServer: name,
        },
        finalizeBilling: ({ result, defaultEvent, durationMs }) => {
          const executionResult = result as McpExecutionResult<TResult> | undefined;
          const metadata = {
            ...defaultEvent.metadata,
            ...(executionResult?.metadata ?? {}),
            durationMs,
          };
          const quantity = sanitizeNumber(
            executionResult?.quantity,
            defaultEvent.quantity ?? 1
          );
          const unitCost = sanitizeNumber(
            executionResult?.unitCost,
            defaultEvent.unitCost ?? 0
          );
          const total = options.costCalculator
            ? options.costCalculator({
                unitCost,
                quantity,
                metadata,
                durationMs,
              })
            : unitCost * quantity;

          return {
            ...defaultEvent,
            unitCost,
            quantity,
            total,
            metadata,
          };
        },
      },
      async (runtime) => {
        const headers = {
          ...(options.headers ?? {}),
          'X-Parent-Trace-Id': runtime.parentTraceId,
        };
        const execution = await server.execute(input, {
          traceId: runtime.traceId,
          parentTraceId: runtime.parentTraceId,
          logger: runtime.logger,
          headers,
        });

        if (typeof execution?.quantity === 'number') {
          runtime.setQuantity(execution.quantity);
        }
        if (typeof execution?.unitCost === 'number') {
          runtime.setUnitCost(execution.unitCost);
        }
        if (execution?.metadata) {
          runtime.recordMetadata(execution.metadata);
        }
        runtime.recordMetadata({ headers });
        return execution;
      }
    );
  };
}

export function generateTraceId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}

function sanitizeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback >= 0 ? fallback : 0;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

function summarizeInput(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === 'string') {
    return input.length > 64 ? `${input.slice(0, 61)}...` : input;
  }
  if (Array.isArray(input)) {
    return `Array(${input.length})`;
  }
  if (typeof input === 'object') {
    const keys = Object.keys(input as Record<string, unknown>);
    return `Object(${keys.slice(0, 5).join(',')}${keys.length > 5 ? ',…' : ''})`;
  }
  return input;
}
