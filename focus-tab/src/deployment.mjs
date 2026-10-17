import { loadConfig } from './config.mjs';

export async function applyInitialActionPreset(
  api,
  local,
  action = typeof FOCUSTAB_INITIAL_AI_ACTION === 'string' ? FOCUSTAB_INITIAL_AI_ACTION : null,
  now = Date.now()
) {
  if (action === null) return local;
  if (!['block', 'remind'].includes(action)) throw new Error('初始拦截方式预设无效');
  const { focusInitialActionPreset: marker } = await api.storage.local.get(
    'focusInitialActionPreset'
  );
  if (marker?.schema === 1 && marker.action === action) return local;
  const focusConfig = { ...loadConfig(local.focusConfig), aiAction: action };
  const changes = {
    focusConfig,
    focusInitialActionPreset: { schema: 1, action, appliedAt: now },
  };
  if (Object.hasOwn(local, 'focusConfig') && local.focusConfig !== undefined) {
    changes.focusConfigBeforeInitialAction = {
      created: now,
      config: structuredClone(local.focusConfig),
    };
  }
  // One write keeps the backup, action and marker together. This preset is a
  // deliberate personal build option, never an unconditional public migration.
  await api.storage.local.set(changes);
  return { ...local, focusConfig };
}
