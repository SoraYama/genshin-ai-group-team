import { useCallback, useEffect, useState } from 'react';
import { api } from '../ipc';
import type { ProfileStateView } from '../../shared/domain';

interface ProfileStateHandle {
  state: ProfileStateView | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useProfileState(): ProfileStateHandle {
  const [state, setState] = useState<ProfileStateView | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.profile.state();
      setState(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, loading, refresh };
}
