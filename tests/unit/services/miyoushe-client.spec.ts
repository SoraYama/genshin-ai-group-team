import { describe, expect, it, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();

vi.mock('undici', () => ({
  request: requestMock
}));

beforeEach(() => {
  requestMock.mockReset();
});

function mockResponse(status: number, payload: unknown) {
  const text = JSON.stringify(payload);
  return {
    statusCode: status,
    body: {
      text: async () => text,
      json: async () => JSON.parse(text)
    }
  };
}

describe('MiyousheClient', () => {
  it('parses a successful role list', async () => {
    requestMock.mockResolvedValueOnce(
      mockResponse(200, {
        retcode: 0,
        data: {
          list: [
            { game_uid: '123456789', region: 'cn_gf01', nickname: 'Traveler', level: 58 },
            { game_uid: '987654321', region: 'cn_qd01' }
          ]
        }
      })
    );

    const { MiyousheClient } = await import('../../../src/main/services/miyoushe-client.js');
    const client = new MiyousheClient();
    const result = await client.fetchRoles('ltoken_v2=abc; ltuid_v2=99;');

    expect(result.ok).toBe(true);
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0]).toEqual({
      gameUid: '123456789',
      region: 'cn_gf01',
      regionName: undefined,
      nickname: 'Traveler',
      level: 58
    });
  });

  it('reports failure when retcode is non-zero', async () => {
    requestMock.mockResolvedValueOnce(
      mockResponse(200, {
        retcode: -100,
        message: '请先登录',
        data: { list: [] }
      })
    );

    const { MiyousheClient } = await import('../../../src/main/services/miyoushe-client.js');
    const client = new MiyousheClient();
    const result = await client.fetchRoles('ltoken_v2=stale; ltuid_v2=99;');

    expect(result.ok).toBe(false);
    expect(result.retcode).toBe(-100);
    expect(result.message).toBe('请先登录');
    expect(result.roles).toHaveLength(0);
  });

  it('handles non-JSON upstream response gracefully', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        text: async () => '<html>maintenance</html>',
        json: async () => {
          throw new Error('not json');
        }
      }
    });

    const { MiyousheClient } = await import('../../../src/main/services/miyoushe-client.js');
    const client = new MiyousheClient();
    const result = await client.fetchRoles('ltoken_v2=abc; ltuid_v2=99;');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('非 JSON');
  });

  it('rejects short cookie payload without firing a request', async () => {
    const { MiyousheClient } = await import('../../../src/main/services/miyoushe-client.js');
    const client = new MiyousheClient();
    const result = await client.fetchRoles('abc');

    expect(result.ok).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
