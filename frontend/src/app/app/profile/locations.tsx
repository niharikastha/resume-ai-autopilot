'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe2, MapPin } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import {
  Button,
  Card,
  CardHeader,
  ErrorNote,
  SkeletonCard,
} from '@/components/ui';
import { api, type PreferencesView, type StatedLocations } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Where you will work.
 *
 * WHY THIS SCREEN EXISTS. This rule used to live in config/targets.yaml, which meant
 * the answer to "would you move to Chennai" was four city names in a file on a server -
 * and those four were silently rejecting 31 real Indian postings, MongoDB in Gurugram
 * and Freshworks in Chennai among them. A rejected posting leaves no row behind, so
 * the loss was invisible: a narrow filter and a quiet job market look identical from
 * the dashboard.
 *
 * The cities are a fixed list from the server, not a text box. A typed city would be a
 * word handed straight to the matcher, and one that matched nothing would look exactly
 * like a city with no jobs in it.
 */
export function LocationsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<StatedLocations | null>(null);

  const prefs = useQuery({
    queryKey: ['me', 'preferences'],
    queryFn: () => api.get<PreferencesView>('/api/me/preferences'),
  });

  const save = useMutation({
    mutationFn: (body: StatedLocations) =>
      api.put<PreferencesView>('/api/me/preferences', body),
    onSuccess: (result) => {
      // The draft is dropped, not kept: what the server sent back IS the saved state,
      // and holding a local copy alongside it is how a screen starts showing an edit
      // that was never written.
      setDraft(null);
      qc.setQueryData(['me', 'preferences'], result);
      toast.success(
        `Saved. ${result.matchingNow.toLocaleString('en-IN')} open postings are in these places right now.`,
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (prefs.isLoading) return <SkeletonCard rows={4} />;
  if (prefs.error) {
    return <ErrorNote message={(prefs.error as Error).message} />;
  }
  if (!prefs.data) return null;

  const view = prefs.data;
  // The draft is only created once something is changed, so an untouched screen shows
  // exactly what the server said and cannot drift from it.
  const current = draft ?? view.locations;
  const edit = (change: Partial<StatedLocations>) =>
    setDraft({ ...current, ...change });

  const dirty = !sameLocations(current, view.locations);
  const empty = matchesNothing(current);
  const metros = view.catalogue.filter((city) => city.metro);
  const others = view.catalogue.filter((city) => !city.metro);

  const toggleCity = (id: string) =>
    edit({
      cities: current.cities.includes(id)
        ? current.cities.filter((each) => each !== id)
        : [...current.cities, id],
    });

  return (
    <Card>
      <CardHeader
        title="Where you will work"
        subtitle="Pick the places you would actually take a job in. Everything else is dropped before a single job is read closely."
      />

      <div className="space-y-5 px-5 py-4 text-sm">
        {!view.stated && (
          <p className="rounded-[var(--r-sm)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-xs text-[var(--ink-secondary)]">
            You have not set this yet, so the shared default below is what is being
            used. Save once and it becomes yours.
          </p>
        )}

        {/* India: everywhere, or a list. A radio and not two checkboxes, because
            "anywhere" and "these cities" are not two things that can both be true -
            when anywhere is on, the city list is ignored entirely. */}
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-semibold tracking-wide text-[var(--ink-muted)] uppercase">
            In India
          </legend>

          <Choice
            type="radio"
            checked={current.anywhereInIndia}
            onChange={() => edit({ anywhereInIndia: true })}
            label="Anywhere in India"
            hint="Any Indian city, including ones not on the list below."
          />
          <Choice
            type="radio"
            checked={!current.anywhereInIndia}
            onChange={() => edit({ anywhereInIndia: false })}
            label="Only the cities I pick"
            hint="A job outside these is dropped even if it is a perfect fit otherwise."
          />
        </fieldset>

        {!current.anywhereInIndia && (
          <div className="space-y-3 border-l border-[var(--border-strong)] pl-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => edit({ cities: [...view.metroCityIds] })}
              >
                Pick the big metros
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => edit({ cities: [] })}
                disabled={current.cities.length === 0}
              >
                Clear
              </Button>
              <span className="text-xs text-[var(--ink-muted)]">
                {current.cities.length === 0
                  ? 'No cities picked'
                  : `${current.cities.length} picked`}
              </span>
            </div>

            <CityGrid
              title="Big metros"
              cities={metros}
              picked={current.cities}
              onToggle={toggleCity}
            />
            <CityGrid
              title="Other cities that hire"
              cities={others}
              picked={current.cities}
              onToggle={toggleCity}
            />

            {current.cities.length === 0 && !hasRemote(current) && (
              <p className="text-xs" style={{ color: 'var(--status-warning)' }}>
                Nothing is picked and no remote work is accepted, so nothing at all
                would match.
              </p>
            )}
          </div>
        )}

        {/* Remote, in three parts, because the three are genuinely different jobs. */}
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-semibold tracking-wide text-[var(--ink-muted)] uppercase">
            Remote work
          </legend>

          <Choice
            type="checkbox"
            checked={current.remoteIndia}
            onChange={(on) => edit({ remoteIndia: on })}
            label="Remote, based in India"
            hint="The posting says remote and says India."
          />
          <Choice
            type="checkbox"
            checked={current.remoteUnspecified}
            onChange={(on) => edit({ remoteUnspecified: on })}
            label='Remote with no country named'
            hint="Most Indian remote postings say only “Remote”. Turning this off loses a lot of real jobs; leaving it on lets a few foreign ones through."
          />
          <Choice
            type="checkbox"
            checked={current.remoteOutsideIndia}
            onChange={(on) => edit({ remoteOutsideIndia: on })}
            label="Remote, outside India"
            hint="Jobs like “Remote — United States”. Off by default: most need the right to work there, and an application spent on one is wasted."
          />
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <p className="text-xs text-[var(--ink-muted)]">
            {dirty ? (
              'Save to see how many postings this covers.'
            ) : (
              <>
                <strong className="text-[var(--ink-secondary)]">
                  {view.matchingNow.toLocaleString('en-IN')}
                </strong>{' '}
                open postings are in these places. That is the place rule only — the
                title, keyword and freshness rules still apply, so the shortlist is
                smaller.
              </>
            )}
          </p>
          <Button
            variant="primary"
            onClick={() => save.mutate(current)}
            busy={save.isPending}
            disabled={!dirty || empty}
          >
            Save
          </Button>
        </div>

        {empty && (
          <p className="text-xs" style={{ color: 'var(--status-warning)' }}>
            Pick at least one city, or turn on anywhere in India, or accept one kind of
            remote work. Otherwise every run finds nothing and it looks like a quiet
            week.
          </p>
        )}
      </div>
    </Card>
  );
}

/** One city checkbox group. The metro/other split is the server's, not a guess here. */
function CityGrid({
  title,
  cities,
  picked,
  onToggle,
}: {
  title: string;
  cities: PreferencesView['catalogue'];
  picked: string[];
  onToggle: (id: string) => void;
}) {
  if (cities.length === 0) return null;

  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
        {title === 'Big metros' ? (
          <Globe2 size={12} aria-hidden />
        ) : (
          <MapPin size={12} aria-hidden />
        )}
        {title}
      </p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {cities.map((city) => {
          const on = picked.includes(city.id);
          return (
            <label
              key={city.id}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-[var(--r-sm)] border px-2.5 py-1.5 text-[13px] transition-colors',
                on
                  ? 'border-[var(--accent)] bg-[var(--surface-hover)] text-[var(--ink-primary)]'
                  : 'border-[var(--border-strong)] text-[var(--ink-secondary)] hover:border-[var(--ink-muted)]',
              )}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(city.id)}
                className="size-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="truncate">{city.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** A radio or checkbox with the sentence that says what it costs. */
function Choice({
  type,
  checked,
  onChange,
  label,
  hint,
}: {
  type: 'radio' | 'checkbox';
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type={type}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
      />
      <span>
        <span className="text-[var(--ink-primary)]">{label}</span>
        <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">{hint}</span>
      </span>
    </label>
  );
}

function hasRemote(stated: StatedLocations): boolean {
  return (
    stated.remoteIndia || stated.remoteUnspecified || stated.remoteOutsideIndia
  );
}

/**
 * The one combination that is valid field by field and admits nothing.
 *
 * Checked here as well as on the server - not instead of it. The server's refusal is
 * the one that counts; this one is what stops the candidate finding out by pressing
 * Save.
 */
function matchesNothing(stated: StatedLocations): boolean {
  return (
    stated.cities.length === 0 && !stated.anywhereInIndia && !hasRemote(stated)
  );
}

/** Order-insensitive, because ticking a city and unticking it is not a change. */
function sameLocations(a: StatedLocations, b: StatedLocations): boolean {
  return (
    a.anywhereInIndia === b.anywhereInIndia &&
    a.remoteIndia === b.remoteIndia &&
    a.remoteUnspecified === b.remoteUnspecified &&
    a.remoteOutsideIndia === b.remoteOutsideIndia &&
    a.cities.length === b.cities.length &&
    [...a.cities].sort().join() === [...b.cities].sort().join()
  );
}
