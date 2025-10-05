const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BillingManager,
  createAgent,
  createMcpTool,
  AgentExecutionError,
  McpRegistry,
} = require('../dist');
const {
  evaluateTheme,
  generateThemes,
  synthesizeNames,
} = require('../dist/mock');

test('BillingManager aggregates totals with default calculator', () => {
  const manager = new BillingManager();
  manager.record({
    stepName: 'Step A',
    actionType: 'llm_call',
    unitCost: 0.002,
    quantity: 3,
  });
  manager.record({
    stepName: 'Step B',
    actionType: 'validation',
    unitCost: 0.001,
  });

  const invoice = manager.generateInvoice();
  assert.equal(invoice.total, 0.007);
  assert.equal(invoice.lineItems.length, 2);
});

test('BillingManager sanitizes invalid numeric inputs', () => {
  const manager = new BillingManager();

  // Negative values should be sanitized to 0
  manager.record({
    stepName: 'Negative Test',
    actionType: 'test',
    unitCost: -1,
    quantity: 2,
  });

  // NaN should be sanitized to 0
  manager.record({
    stepName: 'NaN Test',
    actionType: 'test',
    unitCost: NaN,
    quantity: 2,
  });

  // Infinity should be sanitized to 0
  manager.record({
    stepName: 'Infinity Test',
    actionType: 'test',
    unitCost: Infinity,
    quantity: 1,
  });

  // Valid positive value
  manager.record({
    stepName: 'Valid Test',
    actionType: 'test',
    unitCost: 0.5,
    quantity: 2,
  });

  const invoice = manager.generateInvoice();
  assert.equal(invoice.total, 1.0);
  assert.equal(invoice.lineItems.length, 4);
  assert.equal(invoice.lineItems[0].unitCost, 0);
  assert.equal(invoice.lineItems[1].unitCost, 0);
  assert.equal(invoice.lineItems[2].unitCost, 0);
  assert.equal(invoice.lineItems[3].unitCost, 0.5);
});

test('createAgent propagates invoice via AgentExecutionError on failure', async () => {
  const failingAgent = createAgent('failing', async (step) => {
    await step(
      {
        name: 'Explode',
        actionType: 'validation',
        unitCost: 0.1,
        billOnError: true,
      },
      async () => {
        throw new Error('boom');
      }
    );
    return 'ok';
  });

  await assert.rejects(failingAgent.invoke({}), AgentExecutionError);
});

test('createMcpTool records metadata and cost overrides from MCP execution', async () => {
  const definition = {
    name: 'mock-tool',
    description: 'Doubles numbers',
    defaultUnitCost: 0.001,
    async execute(input) {
      return {
        result: { doubled: input.value * 2 },
        unitCost: 0.002,
        quantity: 1,
        metadata: { value: input.value },
      };
    },
  };

  McpRegistry.register(definition);

  const tool = createMcpTool('mock-tool');
  const agent = createAgent('tool-agent', async (step) => {
    const execution = await tool(step, { value: 2 }, { name: 'Double Value' });
    return execution.result.doubled;
  });

  const run = await agent.invoke({});
  assert.equal(run.output, 4);
  assert.equal(run.invoice.lineItems[0]?.metadata.value, 2);
  assert.equal(run.invoice.lineItems[0]?.unitCost, 0.002);
});

test('coffee agent invoice total scales with additional branches', async () => {
  const coffeeAgent = createAgent(
    'coffee',
    async (step, input) => {
      const generation = await step(
        {
          name: 'Generate Name Themes',
          actionType: 'llm_call',
          unitCost: 0.002,
          metadata: { prompt: input.prompt },
        },
        async (runtime) => {
          const themes = generateThemes(input.prompt, input.branches);
          runtime.setQuantity(themes.themes.length);
          runtime.recordMetadata({
            promptTokens: themes.promptTokens,
            completionTokens: themes.completionTokens,
          });
          return themes;
        }
      );

      for (const theme of generation.themes) {
        await step(
          {
            name: `Evaluate ${theme}`,
            actionType: 'evaluation',
            unitCost: 0.001,
          },
          async () => evaluateTheme(theme)
        );
      }

      await step(
        {
          name: 'Synthesize Final Names',
          actionType: 'llm_call',
          unitCost: 0.002,
        },
        async () => synthesizeNames(input.prompt, generation.themes, 3)
      );

      return generation.themes;
    }
  );

  const runThree = await coffeeAgent.invoke({ prompt: 'Test', branches: 3 });
  const runFive = await coffeeAgent.invoke({ prompt: 'Test', branches: 5 });

  assert.ok(runFive.invoice.total > runThree.invoice.total);
});

test('tree-of-thought agent bills each branch expansion and evaluation', async () => {
  const thoughtAgent = createAgent(
    'treeOfThought',
    async (step, input) => {
      const roots = await step(
        {
          name: 'Generate Root Thoughts',
          actionType: 'llm_call',
          unitCost: 0.002,
          metadata: { depth: 0 },
        },
        async (runtime) => {
          runtime.setQuantity(input.branches);
          const thoughts = Array.from({ length: input.branches }, (_, index) => `Thought-${index + 1}`);
          runtime.recordMetadata({ nodes: thoughts.length });
          return thoughts;
        }
      );

      for (const root of roots) {
        await step(
          {
            name: `Expand ${root}`,
            actionType: 'llm_call',
            unitCost: 0.001,
            metadata: { parent: root },
          },
          async (runtime) => {
            runtime.setQuantity(input.depth);
            runtime.recordMetadata({ childrenCount: input.depth });
            return Array.from({ length: input.depth }, (_, index) => `${root}.${index + 1}`);
          }
        );

        await step(
          {
            name: `Evaluate ${root}`,
            actionType: 'evaluation',
            unitCost: 0.0005,
            metadata: { root },
          },
          async (runtime) => {
            runtime.recordMetadata({ score: 0.85 });
          }
        );
      }

      await step(
        {
          name: 'Select Best Thought',
          actionType: 'synthesis',
          unitCost: 0.002,
        },
        async () => roots[0]
      );

      return roots[0];
    }
  );

  const run = await thoughtAgent.invoke({ depth: 2, branches: 3 });

  assert.equal(run.output, 'Thought-1');
  assert.equal(run.invoice.lineItems.length, 1 + 3 * 2 + 1); // root + (expand/evaluate per branch) + final selection
  const rootLine = run.invoice.lineItems.find((item) => item.stepName === 'Generate Root Thoughts');
  assert.equal(rootLine.quantity, 3);
  const expansionLines = run.invoice.lineItems.filter((item) => item.stepName.startsWith('Expand '));
  assert.equal(expansionLines.length, 3);
  for (const line of expansionLines) {
    assert.equal(line.quantity, 2);
    assert.equal(line.metadata.childrenCount, 2);
  }
  assert.equal(run.invoice.total.toFixed(4), '0.0155');
});
