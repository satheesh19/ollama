export async function* parseJsonlFromResponse<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    throw new Error('Response body is null');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      // Keep the last partial line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            yield JSON.parse(line) as T;
          } catch (e) {
            console.error('Failed to parse JSONL line:', line, e);
          }
        }
      }
    }

    // Process any remaining content in the buffer
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as T;
      } catch (e) {
        console.error('Failed to parse final JSONL line:', buffer, e);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
