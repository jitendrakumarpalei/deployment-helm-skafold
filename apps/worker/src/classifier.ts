export interface ClassifierResponse {
  action_type: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function classifyPrompt(
  endpoint: string,
  apiKey: string | undefined,
  job: { logId: string; promptContent: string }
): Promise<ClassifierResponse> {
  let attempts = 0;
  const maxAttempts = 3;
  const timeout = 30000; // 30 seconds

  while (attempts < maxAttempts) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(job),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Classifier request failed with ${response.status}`);
      }

      return response.json();
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        throw error;
      }
      const delay = 1000 * 2 ** (attempts - 1);
      await sleep(delay);
    }
  }

  throw new Error('Classifier request failed after multiple retries');
}
