import { activeProfile, type Config, type Profile } from '@nightshift/core'

export type EffectiveLimits = Config['limits']['worker'] &
  Pick<NonNullable<Profile['limits']>, 'max_estimate' | 'max_files'>

export function effectiveLimits(
  config: Pick<Config, 'profiles' | 'limits'> & Partial<Pick<Config, 'repositories'>>,
  profile: string = config.profiles.active,
  repository?: string,
): EffectiveLimits {
  return {
    ...config.limits.worker,
    ...(repository === undefined ? {} : config.repositories?.[repository]?.limits),
    ...activeProfile(config.profiles, profile).profile.limits,
  }
}
