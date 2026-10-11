import { activeProfile, type Config, type Profile } from '@nightshift/core'

export type EffectiveLimits = Config['limits']['worker'] &
  Pick<NonNullable<Profile['limits']>, 'max_estimate' | 'max_files'>

export function effectiveLimits(
  config: Pick<Config, 'profiles' | 'limits'>,
  profile: string = config.profiles.active,
): EffectiveLimits {
  return { ...config.limits.worker, ...activeProfile(config.profiles, profile).profile.limits }
}
