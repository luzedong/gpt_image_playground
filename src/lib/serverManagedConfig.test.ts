import { describe, expect, it, vi } from 'vitest'

describe('server-managed API configuration', () => {
  it('discards client profiles and keeps the fixed image/Agent pair', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API_CONFIG', 'true')
    vi.resetModules()

    const { DEFAULT_AGENT_PROFILE_ID, DEFAULT_OPENAI_PROFILE_ID, DEFAULT_PIXEL_IMAGE_MODEL, normalizeSettings, validateApiProfile } = await import('./apiProfiles')
    const settings = normalizeSettings({
      profiles: [
        {
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
        },
        {
          id: 'default-openai',
          provider: 'openai',
          model: 'custom-image-model',
          streamImages: true,
          streamPartialImages: 3,
        },
      ],
      activeProfileId: 'client-profile',
      agentApiConfigMode: 'off',
      agentTextProfileId: 'client-profile',
      agentImageProfileId: 'client-profile',
    })

    expect(settings.profiles.map((profile) => profile.id)).toEqual([
      DEFAULT_OPENAI_PROFILE_ID,
      'default-ailink-image',
      DEFAULT_AGENT_PROFILE_ID,
    ])
    expect(settings).toMatchObject({
      activeProfileId: DEFAULT_OPENAI_PROFILE_ID,
      agentApiConfigMode: 'hybrid',
      agentTextProfileId: DEFAULT_AGENT_PROFILE_ID,
      agentImageProfileId: DEFAULT_OPENAI_PROFILE_ID,
    })
    expect(settings.profiles[0]).toMatchObject({ baseUrl: '', apiKey: '', model: DEFAULT_PIXEL_IMAGE_MODEL, apiProxy: true })
    expect(settings.profiles[0]).toMatchObject({ streamImages: true, streamPartialImages: 3 })
    expect(settings.profiles[2]).toMatchObject({ baseUrl: '', apiKey: '', model: 'gpt-5.6-luna', apiProxy: true })
    expect(validateApiProfile(settings.profiles[2])).toBeNull()
  })

  it('always restores the AILink image profile after a blank server-managed initialization', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API_CONFIG', 'true')
    vi.resetModules()

    const { DEFAULT_AILINK_PROFILE_ID, DEFAULT_OPENAI_PROFILE_ID, getAgentImageApiProfile, normalizeSettings } = await import('./apiProfiles')
    const settings = normalizeSettings({ activeProfileId: DEFAULT_AILINK_PROFILE_ID })

    expect(settings.profiles.map((profile) => profile.id)).toContain(DEFAULT_AILINK_PROFILE_ID)
    expect(settings.activeProfileId).toBe(DEFAULT_AILINK_PROFILE_ID)
    expect(settings.agentImageProfileId).toBe(DEFAULT_AILINK_PROFILE_ID)
    expect(getAgentImageApiProfile(settings)?.id).toBe(DEFAULT_AILINK_PROFILE_ID)
    expect(settings.profiles.find((profile) => profile.id === DEFAULT_OPENAI_PROFILE_ID)).toBeDefined()
  })

  it('forces the AIPixel model while preserving the AILink model', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API_CONFIG', 'true')
    vi.resetModules()

    const { DEFAULT_PIXEL_IMAGE_MODEL, normalizeSettings } = await import('./apiProfiles')
    const settings = normalizeSettings({
      profiles: [
        { id: 'default-openai', provider: 'openai', model: 'pixel-image-model' },
        { id: 'default-ailink-image', provider: 'openai', model: 'ailink-image-model' },
      ],
    })

    expect(settings.profiles.find((profile) => profile.id === 'default-openai')?.model).toBe(DEFAULT_PIXEL_IMAGE_MODEL)
    expect(settings.profiles.find((profile) => profile.id === 'default-ailink-image')?.model).toBe('ailink-image-model')
  })

  it('forces network search on for legacy settings', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API_CONFIG', 'true')
    vi.resetModules()

    const { normalizeSettings } = await import('./apiProfiles')
    expect(normalizeSettings({ agentWebSearch: false }).agentWebSearch).toBe(true)
  })

  it('preserves the selected server-managed Agent image profile', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API_CONFIG', 'true')
    vi.resetModules()

    const { DEFAULT_AILINK_PROFILE_ID, DEFAULT_AGENT_PROFILE_ID, DEFAULT_OPENAI_PROFILE_ID, createDefaultAilinkProfile, getAgentImageApiProfile, normalizeSettings } = await import('./apiProfiles')
    const settings = normalizeSettings({
      profiles: [createDefaultAilinkProfile()],
      agentImageProfileId: DEFAULT_AILINK_PROFILE_ID,
    })

    expect(settings.agentImageProfileId).toBe(DEFAULT_AILINK_PROFILE_ID)
    expect(getAgentImageApiProfile(settings)).toMatchObject({
      id: DEFAULT_AILINK_PROFILE_ID,
      name: 'AILink 图像（1K–4K）',
    })
    expect(settings.agentTextProfileId).toBe(DEFAULT_AGENT_PROFILE_ID)
    expect(settings.profiles.find((profile) => profile.id === DEFAULT_OPENAI_PROFILE_ID)).toBeDefined()
  })
})
