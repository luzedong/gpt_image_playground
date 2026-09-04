import { describe, expect, it, vi } from 'vitest'

describe('server-managed API configuration', () => {
  it('discards client profiles and keeps the fixed image/Agent pair', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API_CONFIG', 'true')
    vi.resetModules()

    const { DEFAULT_AGENT_PROFILE_ID, DEFAULT_OPENAI_PROFILE_ID, normalizeSettings, validateApiProfile } = await import('./apiProfiles')
    const settings = normalizeSettings({
      profiles: [{
        id: 'client-profile',
        name: '客户端配置',
        provider: 'openai',
        baseUrl: 'https://client.example.com/v1',
        apiKey: 'client-key',
        model: 'client-model',
        timeout: 600,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
        transparentBackgroundMethod: 'api',
      }],
      activeProfileId: 'client-profile',
      agentApiConfigMode: 'off',
      agentTextProfileId: 'client-profile',
      agentImageProfileId: 'client-profile',
    })

    expect(settings.profiles.map((profile) => profile.id)).toEqual([
      DEFAULT_OPENAI_PROFILE_ID,
      DEFAULT_AGENT_PROFILE_ID,
    ])
    expect(settings).toMatchObject({
      activeProfileId: DEFAULT_OPENAI_PROFILE_ID,
      agentApiConfigMode: 'hybrid',
      agentTextProfileId: DEFAULT_AGENT_PROFILE_ID,
      agentImageProfileId: DEFAULT_OPENAI_PROFILE_ID,
    })
    expect(settings.profiles[0]).toMatchObject({ baseUrl: '', apiKey: '', model: 'gpt-image-2', apiProxy: true })
    expect(settings.profiles[1]).toMatchObject({ baseUrl: '', apiKey: '', model: 'gpt-5.6-luna', apiProxy: true })
    expect(validateApiProfile(settings.profiles[1])).toBeNull()
  })
})
