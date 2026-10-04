import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import {
  EMPTY_SETUP,
  EMPTY_TASTE,
  SETUP_KEY,
  TASTE_KEY,
  parseSetup,
  parseTaste,
  readStored,
  type Setup,
  type Taste,
} from "../lib/onboarding";

export function usePreferences() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [taste, setTaste] = useState<Taste>(EMPTY_TASTE);
  const [setup, setSetup] = useState<Setup>(EMPTY_SETUP);
  const current = useRef({ taste: EMPTY_TASTE, setup: EMPTY_SETUP });
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    AsyncStorage.multiGet([TASTE_KEY, SETUP_KEY])
      .then((entries) => {
        if (!active) return;
        const stored = new Map(entries);
        const loadedTaste = readStored(
          stored.get(TASTE_KEY) || null,
          parseTaste,
        );
        const loadedSetup = {
          ...readStored(stored.get(SETUP_KEY) || null, parseSetup),
        };
        // Someone who answered the earlier taste picker goes straight to the location step.
        if (!stored.get(SETUP_KEY) && loadedTaste.asked)
          loadedSetup.step = "nearby";
        current.current = { taste: loadedTaste, setup: loadedSetup };
        setTaste(loadedTaste);
        setSetup(loadedSetup);
      })
      .catch(() => {
        if (active)
          setError(
            "Your preferences couldn’t be loaded. You can choose them again.",
          );
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  function update(next: { taste?: Taste; setup?: Setup }) {
    const snapshot = { ...current.current, ...next };
    current.current = snapshot;
    setTaste(snapshot.taste);
    setSetup(snapshot.setup);
    // Serialize snapshots so an older tap can never overwrite a newer choice or completion.
    writes.current = writes.current
      .then(() =>
        AsyncStorage.multiSet([
          [TASTE_KEY, JSON.stringify(snapshot.taste)],
          [SETUP_KEY, JSON.stringify(snapshot.setup)],
        ]),
      )
      .then(() => setError(undefined))
      .catch(() => {
        setError(
          "Your choices work for this session, but couldn’t be saved on this device.",
        );
      });
    return writes.current;
  }
  return { ready, error, taste, setup, current, update };
}
