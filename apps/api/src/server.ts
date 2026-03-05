import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { readConfig, type AppConfig } from './config.js';
import { requiredCheckNames, runExternalChecks } from './services/external-health.js';
import { fetchMiyousheRoles, validateMiyousheCookie } from './services/miyoushe-client.js';
import { fetchEnkaProfiles } from './services/enka-client.js';
import { ProfileCache } from './services/profile-cache.js';
import type { CachedProfileEntry } from './types/profile.js';
import { generateRecommendation, type RecommendationResult } from './services/recommendation.js';
import type { CharacterProfile } from './types/profile.js';
import { RecommendationCache } from './services/recommendation-cache.js';
import type { RecommendationCompareResult } from './types/recommendation.js';

export interface BuildServerOptions {
  config?: AppConfig;
  fetchImpl?: typeof fetch;
}

const cookieBodySchema = z.object({
  cookie: z.string().min(10, 'Cookie looks too short')
});

const importBodySchema = cookieBodySchema.extend({
  uid: z.string().min(8).optional()
});

const recommendationBodySchema = z.object({
  uid: z.string().min(8).optional(),
  characters: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        element: z.string(),
        rarity: z.number(),
        imageUrl: z.string(),
        stats: z.object({
          level: z.number(),
          hp: z.number(),
          atk: z.number(),
          def: z.number(),
          critRate: z.number(),
          critDmg: z.number(),
          energyRecharge: z.number(),
          elementalMastery: z.number()
        })
      })
    )
    .optional(),
  enemyNames: z.array(z.string()).optional(),
  preference: z.string().optional()
});

const compareBodySchema = z.object({
  uid: z.string().min(8).optional(),
  characters: recommendationBodySchema.shape.characters,
  leftEnemyNames: z.array(z.string()).default([]),
  rightEnemyNames: z.array(z.string()).default([]),
  leftPreference: z.string().optional(),
  rightPreference: z.string().optional()
});

function parseEnemyNames(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload
      .filter((item): item is string => typeof item === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 50);
  }

  if (payload && typeof payload === 'object') {
    const objectValue = payload as Record<string, unknown>;
    const data = objectValue.data;
    if (data && typeof data === 'object') {
      const items = (data as Record<string, unknown>).items;
      if (items && typeof items === 'object') {
        return Object.keys(items).slice(0, 50);
      }
    }
  }

  return [];
}

function normalizeEnemyNames(input: string[]): string[] {
  return input
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 50);
}

function diffRecommendation(left: RecommendationResult, right: RecommendationResult): string {
  const leftChars = new Set(
    left.teams.flatMap((team) => team.characters.map((character) => character.name))
  );
  const rightChars = new Set(
    right.teams.flatMap((team) => team.characters.map((character) => character.name))
  );

  const onlyLeft = Array.from(leftChars).filter((name) => !rightChars.has(name));
  const onlyRight = Array.from(rightChars).filter((name) => !leftChars.has(name));

  if (onlyLeft.length === 0 && onlyRight.length === 0) {
    return '两组敌人环境下推荐核心角色基本一致，主要差异在站位与循环顺序。';
  }

  const leftText = onlyLeft.length > 0 ? `左环境更偏好：${onlyLeft.join('、')}` : '左环境未出现独有角色';
  const rightText = onlyRight.length > 0 ? `右环境更偏好：${onlyRight.join('、')}` : '右环境未出现独有角色';
  return `${leftText}；${rightText}。`;
}

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const config = options.config ?? readConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const profileCache = new ProfileCache(config.profileCacheFile);
  const recommendationCache = new RecommendationCache(config.recommendationCacheFile);

  app.addHook('onReady', async () => {
    await profileCache.hydrate();
    await recommendationCache.hydrate();
  });

  app.register(cors, {
    origin: true
  });

  app.get('/api/ping', async () => ({ ok: true }));

  app.get('/api/health', async (request, reply) => {
    const includeMiyoushe = request.query !== null && typeof request.query === 'object' && 'includeMiyoushe' in request.query;
    const cookieHeader = request.headers['x-miyoushe-cookie'];
    const miyousheCookie = typeof cookieHeader === 'string' ? cookieHeader : undefined;

    const checks = await runExternalChecks({
      config,
      fetchImpl,
      miyousheCookie: includeMiyoushe ? miyousheCookie : undefined
    });

    const required = requiredCheckNames(config, includeMiyoushe);
    const failedRequired = checks.filter((check) => required.includes(check.name) && check.status !== 'up');

    if (failedRequired.length > 0) {
      return reply.code(503).send({
        ok: false,
        required,
        checks
      });
    }

    return reply.send({
      ok: true,
      required,
      checks
    });
  });

  app.post('/api/health/miyoushe', async (request, reply) => {
    const parsed = cookieBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        errors: parsed.error.flatten()
      });
    }

    const result = await validateMiyousheCookie({
      cookie: parsed.data.cookie,
      config,
      fetchImpl
    });

    const status = result.ok ? 200 : 401;
    return reply.code(status).send(result);
  });

  app.post('/api/mys/validate-cookie', async (request, reply) => {
    const parsed = cookieBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        errors: parsed.error.flatten()
      });
    }

    const result = await validateMiyousheCookie({
      cookie: parsed.data.cookie,
      config,
      fetchImpl
    });

    const status = result.ok ? 200 : 401;
    return reply.code(status).send(result);
  });

  app.post('/api/mys/import', async (request, reply) => {
    const parsed = importBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        errors: parsed.error.flatten()
      });
    }

    const roleResult = await fetchMiyousheRoles({
      cookie: parsed.data.cookie,
      config,
      fetchImpl
    });

    if (!roleResult.ok || roleResult.roles.length === 0) {
      return reply.code(401).send({
        ok: false,
        message: roleResult.message ?? 'No available game roles found with provided cookie'
      });
    }

    const sortedRoles = roleResult.roles.slice().sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
    const targetRole =
      (parsed.data.uid
        ? roleResult.roles.find((role) => role.gameUid === parsed.data.uid)
        : undefined) ??
      sortedRoles[0] ??
      roleResult.roles[0];

    if (!targetRole) {
      return reply.code(500).send({
        ok: false,
        message: 'Failed to select target role'
      });
    }

    let enkaProfiles: {
      uid: string;
      profiles: CachedProfileEntry['profiles'];
      nickname?: string;
      level?: number;
    } = {
      uid: targetRole.gameUid,
      profiles: []
    };
    try {
      enkaProfiles = await fetchEnkaProfiles({
        uid: targetRole.gameUid,
        config,
        fetchImpl
      });
    } catch (error) {
      app.log.warn({ error }, 'Enka import failed, falling back to Miyoushe role-only cache');
    }

    const entry: CachedProfileEntry = {
      uid: targetRole.gameUid,
      region: targetRole.region,
      nickname: enkaProfiles.nickname ?? targetRole.nickname,
      level: enkaProfiles.level ?? targetRole.level,
      source: enkaProfiles.profiles.length > 0 ? 'miyoushe+enka' : 'miyoushe',
      updatedAt: new Date().toISOString(),
      profiles: enkaProfiles.profiles
    };

    profileCache.set(entry);
    await profileCache.persist();

    return reply.send({
      ok: true,
      data: entry
    });
  });

  app.get('/api/profile/:uid', async (request, reply) => {
    const params = request.params as { uid?: string };
    const uid = params.uid;

    if (!uid) {
      return reply.code(400).send({
        ok: false,
        message: 'Missing uid path parameter'
      });
    }

    const cached = profileCache.get(uid);
    if (!cached) {
      return reply.code(404).send({
        ok: false,
        message: 'Profile not found in local cache'
      });
    }

    return reply.send({
      ok: true,
      data: cached
    });
  });

  app.get('/api/enemy/current', async (request, reply) => {
    try {
      const response = await fetchImpl(config.enemyDataUrl);
      const json = (await response.json()) as unknown;
      const names = parseEnemyNames(json);

      return reply.send({
        ok: response.ok,
        data: {
          source: config.enemyDataUrl,
          enemies: names,
          fetchedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      return reply.code(502).send({
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to fetch enemy data'
      });
    }
  });

  function resolveCharacters(input: {
    uid?: string;
    characters?: CharacterProfile[];
  }): { uid?: string; characters: CharacterProfile[] } {
    if (input.characters && input.characters.length > 0) {
      return {
        uid: input.uid,
        characters: input.characters
      };
    }

    if (input.uid) {
      const cached = profileCache.get(input.uid);
      if (cached) {
        return {
          uid: cached.uid,
          characters: cached.profiles
        };
      }
    }

    return {
      uid: input.uid,
      characters: []
    };
  }

  app.post('/api/ai/recommend', async (request, reply) => {
    const parsed = recommendationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        errors: parsed.error.flatten()
      });
    }

    const resolved = resolveCharacters({
      uid: parsed.data.uid,
      characters: parsed.data.characters
    });
    const characters = resolved.characters;

    if (characters.length < 4) {
      return reply.code(400).send({
        ok: false,
        message: 'At least 4 characters are required for recommendation'
      });
    }

    const enemyNames = normalizeEnemyNames(parsed.data.enemyNames ?? []);

    const recommendation = await generateRecommendation({
      config,
      characters,
      enemyNames,
      preference: parsed.data.preference,
      fetchImpl
    });

    recommendationCache.append({
      uid: resolved.uid,
      enemyNames,
      preference: parsed.data.preference,
      source: recommendation.source,
      summary: recommendation.summary,
      teams: recommendation.teams
    });
    await recommendationCache.persist();

    return reply.send({
      ok: true,
      data: recommendation
    });
  });

  app.get('/api/recommend/history', async (request, reply) => {
    const query = request.query as {
      uid?: string;
      offset?: string;
      limit?: string;
      source?: 'llm' | 'fallback';
      enemyKeyword?: string;
      fromDate?: string;
      toDate?: string;
    };
    const offset = query.offset ? Number(query.offset) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;

    const result = recommendationCache.query({
      uid: query.uid,
      offset: Number.isFinite(offset) ? offset : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      source: query.source === 'llm' || query.source === 'fallback' ? query.source : undefined,
      enemyKeyword: query.enemyKeyword,
      fromDate: query.fromDate,
      toDate: query.toDate
    });

    return reply.send({
      ok: true,
      data: result
    });
  });

  app.delete('/api/recommend/history/:id', async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id;

    if (!id) {
      return reply.code(400).send({
        ok: false,
        message: 'Missing history id'
      });
    }

    const removed = recommendationCache.removeById(id);
    if (!removed) {
      return reply.code(404).send({
        ok: false,
        message: 'History entry not found'
      });
    }

    await recommendationCache.persist();

    return reply.send({
      ok: true,
      removed: 1
    });
  });

  app.delete('/api/recommend/history', async (request, reply) => {
    const query = request.query as {
      uid?: string;
      source?: 'llm' | 'fallback';
      enemyKeyword?: string;
    };

    const source = query.source === 'llm' || query.source === 'fallback' ? query.source : undefined;
    const removed = recommendationCache.removeMany({
      uid: query.uid,
      source,
      enemyKeyword: query.enemyKeyword
    });

    await recommendationCache.persist();

    return reply.send({
      ok: true,
      removed
    });
  });

  app.post('/api/recommend/compare', async (request, reply) => {
    const parsed = compareBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        errors: parsed.error.flatten()
      });
    }

    const resolved = resolveCharacters({
      uid: parsed.data.uid,
      characters: parsed.data.characters
    });

    if (resolved.characters.length < 4) {
      return reply.code(400).send({
        ok: false,
        message: 'At least 4 characters are required for comparison recommendation'
      });
    }

    const leftEnemyNames = normalizeEnemyNames(parsed.data.leftEnemyNames);
    const rightEnemyNames = normalizeEnemyNames(parsed.data.rightEnemyNames);

    const [left, right] = await Promise.all([
      generateRecommendation({
        config,
        characters: resolved.characters,
        enemyNames: leftEnemyNames,
        preference: parsed.data.leftPreference,
        fetchImpl
      }),
      generateRecommendation({
        config,
        characters: resolved.characters,
        enemyNames: rightEnemyNames,
        preference: parsed.data.rightPreference,
        fetchImpl
      })
    ]);

    const compareResult: RecommendationCompareResult = {
      left,
      right,
      diffSummary: diffRecommendation(left, right)
    };

    recommendationCache.append({
      uid: resolved.uid,
      enemyNames: leftEnemyNames,
      preference: parsed.data.leftPreference,
      source: left.source,
      summary: `[对比-左] ${left.summary}`,
      teams: left.teams
    });

    recommendationCache.append({
      uid: resolved.uid,
      enemyNames: rightEnemyNames,
      preference: parsed.data.rightPreference,
      source: right.source,
      summary: `[对比-右] ${right.summary}`,
      teams: right.teams
    });

    await recommendationCache.persist();

    return reply.send({
      ok: true,
      data: compareResult
    });
  });

  return app;
}
