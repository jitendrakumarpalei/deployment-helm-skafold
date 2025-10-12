export interface ClassifierResponse {
  action_type: string;
}

export async function classifyPrompt(
  endpoint: string,
  apiKey: string | undefined,
  job: { logId: string; promptContent: string }
): Promise<ClassifierResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(job),
  });

  if (!response.ok) {
    throw new Error(`Classifier request failed with ${response.status}`);
  }

  return response.json();
}
