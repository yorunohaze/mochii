// Things to do together. Walking is just one of them.
// energy: 0 = low effort, 1 = some, 2 = a lot. Low-energy options are favoured on quieter days.
// osm: OpenStreetMap tags used to find a real place near both people.
// strangerOk: suitable for meeting someone new in stranger mode (public, daytime, low-intimacy). Never homes or sauna.

export const ACTIVITIES = [
  {
    id: 'coffee', emoji: '☕', name: 'Coffee', strangerOk: true,
    ask: 'Do you like meeting someone for a coffee?',
    propose: (p) => `Grab a coffee with ${p}?`,
    did: (p) => `Did you and ${p} have that coffee?`,
    energy: 0, minutes: 45, times: ['morning', 'afternoon'],
    osm: ['[amenity=cafe]'], search: 'cafe', placeLabel: 'a café near you both',
  },
  {
    id: 'walk', emoji: '🚶', name: 'Walk', strangerOk: true,
    ask: 'Do you like going for walks?',
    propose: (p) => `Go for a walk with ${p}?`,
    did: (p) => `Did you and ${p} go for that walk?`,
    energy: 1, minutes: 30, times: ['morning', 'afternoon', 'evening'],
    osm: ['[leisure=park]'], search: 'park', placeLabel: 'a park near you both',
  },
  {
    id: 'cook', emoji: '🍝', name: 'Cooking',
    ask: 'Do you like cooking or eating with someone?',
    propose: (p) => `Cook dinner together with ${p}?`,
    did: (p) => `Did you and ${p} cook together?`,
    energy: 1, minutes: 90, times: ['evening'], home: true,
  },
  {
    id: 'gym', emoji: '🏋️', name: 'Gym', strangerOk: true,
    ask: 'Do you like working out at a gym?',
    propose: (p) => `Go to the gym with ${p}?`,
    did: (p) => `Did you and ${p} make it to the gym?`,
    energy: 2, minutes: 60, times: ['morning', 'afternoon', 'evening'],
    osm: ['[leisure=fitness_centre]'], search: 'gym', placeLabel: 'a gym near you both',
  },
  {
    id: 'groceries', emoji: '🛒', name: 'Groceries',
    ask: 'Would grocery shopping feel easier with company?',
    propose: (p) => `Do a grocery run with ${p}?`,
    did: (p) => `Did you and ${p} do the grocery run?`,
    energy: 0, minutes: 30, times: ['afternoon', 'evening'],
    osm: ['[shop=supermarket]'], search: 'supermarket', placeLabel: 'a supermarket near you both',
  },
  {
    id: 'sauna', emoji: '🧖', name: 'Sauna',
    ask: 'Do you like going to the sauna?',
    propose: (p) => `Go to the sauna with ${p}?`,
    did: (p) => `Did you and ${p} go to the sauna?`,
    energy: 1, minutes: 90, times: ['afternoon', 'evening'],
    osm: ['[leisure=sauna]', '[amenity=public_bath]'], search: 'public sauna', placeLabel: 'a sauna near you both',
  },
  {
    id: 'swim', emoji: '🏊', name: 'Swimming',
    ask: 'Do you like swimming?',
    propose: (p) => `Go swimming with ${p}?`,
    did: (p) => `Did you and ${p} go swimming?`,
    energy: 2, minutes: 60, times: ['morning', 'afternoon', 'evening'],
    // Swimming halls only: plain swimming_pool also matches kids' wading pools and private pools.
    osm: ['[leisure=sports_centre][sport=swimming]', '[leisure=water_park]'],
    search: 'swimming hall', placeLabel: 'a swimming hall near you both',
  },
  {
    id: 'movie', emoji: '🎬', name: 'Movie night',
    ask: 'Do you like a movie night in?',
    propose: (p) => `Have a movie night with ${p}?`,
    did: (p) => `Did you and ${p} watch that movie?`,
    energy: 0, minutes: 120, times: ['evening'], home: true,
  },
  {
    id: 'study', emoji: '📚', name: 'Study together', strangerOk: true,
    ask: 'Does it help to study or work next to someone?',
    propose: (p) => `Study or work side by side with ${p}?`,
    did: (p) => `Did you and ${p} get some work done together?`,
    energy: 0, minutes: 90, times: ['morning', 'afternoon'],
    osm: ['[amenity=library]'], search: 'library', placeLabel: 'a library near you both',
  },
  {
    id: 'games', emoji: '🎲', name: 'Games',
    ask: 'Do you like playing board or video games with friends?',
    propose: (p) => `Play some games with ${p}?`,
    did: (p) => `Did you and ${p} play some games?`,
    energy: 0, minutes: 90, times: ['afternoon', 'evening'], home: true,
  },
];

export const byId = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a]));

export const SLOTS = {
  morning: { hour: 10, label: 'morning' },
  afternoon: { hour: 14, label: 'afternoon' },
  evening: { hour: 18, label: 'evening' },
};

export const TIME_QUESTIONS = {
  morning: 'Are mornings a good time for you to do things?',
  afternoon: 'Are afternoons a good time for you?',
  evening: 'Are evenings a good time for you?',
};
