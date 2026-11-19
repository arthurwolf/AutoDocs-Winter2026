export interface SessionEvent {
  label: string;
  depth: number; // -1 = subevent, 0 = independent, >=1 = exiting
  content?: string | null; // Original XML, available for version 2 sessions
}

export function parseSessionContent(raw: string): SessionEvent[] {
  // New sessions store structured JSON with the original event XML.
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);

      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'version' in parsed &&
        parsed.version === 2 &&
        'events' in parsed &&
        Array.isArray(parsed.events)
      ) {
        return parsed.events.flatMap((entry: unknown): SessionEvent[] => {
          if (entry === null || typeof entry !== 'object') return [];

          const event = entry as Record<string, unknown>;
          if (
            typeof event.label !== 'string' ||
            typeof event.depth !== 'number' ||
            !Number.isFinite(event.depth)
          ) {
            return [];
          }

          return [{
            label: event.label,
            depth: event.depth,
            content: typeof event.content === 'string' ? event.content : null,
          }];
        });
      }
    } catch {
      // Not valid versioned JSON: fall back to the legacy format.
    }
  }

  // Keep existing sessions compatible.
  const lines = raw.split('\n');
  const events: SessionEvent[] = [];
  let i = 0;

  while (i < lines.length) {
    const label = lines[i].trim();
    if (!label) { i++; continue; }

    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;

    if (j < lines.length) {
      const depthVal = parseInt(lines[j].trim(), 10);
      if (!isNaN(depthVal)) {
        events.push({ label, depth: depthVal });
        i = j + 1;
        continue;
      }
    }

    i++;
  }

  return events;
}
