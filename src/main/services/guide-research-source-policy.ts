import { z } from 'zod';

import {
  GuideResearchAgentError,
  type GuideResearchSourcesByHost
} from './guide-research-contract.js';

const sourceRegistryResultSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            id: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
            host: z.string().trim().min(1).max(253),
            trust: z.literal('trusted-local')
          })
          .passthrough()
      )
      .min(1)
      .max(128)
  })
  .passthrough()
  .superRefine(({ sources }, context) => {
    const sourceIds = new Set<string>();
    sources.forEach((source, index) => {
      if (sourceIds.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'id'],
          message: 'Trusted source IDs must be unique'
        });
      }
      sourceIds.add(source.id);
    });
  });

type SourceRegistryResult = z.infer<typeof sourceRegistryResultSchema>;

export function trustedSourcesByCanonicalHost(value: unknown): Map<string, { id: string }> {
  const parsed = sourceRegistryResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new GuideResearchAgentError(
      'RESEARCH_TASK_INVALID',
      'Trusted source registry projection is invalid',
      { cause: parsed.error }
    );
  }
  return sourcesByCanonicalHost(parsed.data);
}

function sourcesByCanonicalHost(registry: SourceRegistryResult): Map<string, { id: string }> {
  const sources = new Map<string, { id: string }>();
  registry.sources.forEach((source) => {
    const host = canonicalHostname(source.host);
    if (host === undefined) {
      throw new GuideResearchAgentError(
        'RESEARCH_TASK_INVALID',
        'Trusted source registry contains an invalid host'
      );
    }
    const existing = sources.get(host);
    if (existing === undefined || source.id < existing.id) {
      sources.set(host, { id: source.id });
    }
  });
  return sources;
}

const DIRECT_SEARCH_ONLY_SOURCES = [
  {
    id: 'search-only-hoyolab-www',
    host: 'www.hoyolab.com'
  },
  {
    id: 'search-only-3dm-genshin',
    host: 'ol.3dmgame.com'
  }
] as const;

export function sourcesForDirectGuideSearch(
  trustedSources: GuideResearchSourcesByHost
): Map<string, { id: string }> {
  const sources = new Map(trustedSources);
  for (const source of DIRECT_SEARCH_ONLY_SOURCES) {
    if (!sources.has(source.host)) {
      sources.set(source.host, { id: source.id });
    }
  }
  return sources;
}

export function canonicalGuideSource(
  value: string,
  sourcesByHost: GuideResearchSourcesByHost
): { sourceId: string; url: string } | undefined {
  const rawHostname = rawAsciiHttpsHostname(value);
  if (rawHostname === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0
  ) {
    return undefined;
  }
  const hostname = canonicalHostname(url.hostname);
  if (hostname === undefined || hostname !== rawHostname) return undefined;
  const source = sourcesByHost.get(hostname);
  if (source === undefined) return undefined;
  url.hostname = hostname;
  return { sourceId: source.id, url: url.href };
}

function rawAsciiHttpsHostname(value: string): string | undefined {
  if (value.length === 0 || value.length > 2_048) return undefined;
  const match = /^https:\/\/([^/?#]*)/iu.exec(value);
  const authority = match?.[1];
  if (
    authority === undefined ||
    authority.length === 0 ||
    /[^\u0021-\u007e]/u.test(authority) ||
    authority.includes('@') ||
    authority.includes(':') ||
    authority.includes('[') ||
    authority.includes(']') ||
    authority.endsWith('.')
  ) {
    return undefined;
  }
  return canonicalHostname(authority);
}

function canonicalHostname(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      normalized
    )
  ) {
    return undefined;
  }
  return normalized;
}
