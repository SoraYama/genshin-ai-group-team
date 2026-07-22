import { z } from 'zod';

export const characterKnowledgeFieldSchema = z.enum([
  'weaponType',
  'roles',
  'energyCost',
  'energyNeeds',
  'capabilities',
  'applicationNotes',
  'kitNotes'
]);

export const characterCapabilitySchema = z.enum([
  'healing',
  'shield',
  'grouping',
  'off-field',
  'on-field',
  'onslaught',
  'plunging',
  'normal-attack',
  'charged-attack'
]);

export const weaponTypeSchema = z.enum(['sword', 'claymore', 'polearm', 'bow', 'catalyst']);
export const characterRoleSchema = z.enum([
  'on-field',
  'off-field',
  'support',
  'sustain',
  'driver'
]);

const noteSchema = z.string().trim().min(1).max(240);
const optionalKnowledgeFields = [
  'weaponType',
  'roles',
  'energyCost',
  'energyNeeds',
  'capabilities',
  'applicationNotes',
  'kitNotes'
] as const;

export const characterKnowledgeEntrySchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    name: z.string().trim().min(1).max(80),
    weaponType: weaponTypeSchema.optional(),
    roles: z.array(characterRoleSchema).max(6).optional(),
    energyCost: z.number().int().min(0).max(100).optional(),
    energyNeeds: z.enum(['low', 'medium', 'high']).optional(),
    capabilities: z.array(characterCapabilitySchema).max(12).optional(),
    applicationNotes: z.array(noteSchema).max(8).optional(),
    kitNotes: z.array(noteSchema).max(8).optional(),
    unknownFields: z.array(characterKnowledgeFieldSchema).max(7)
  })
  .strict()
  .superRefine((entry, context) => {
    const unknown = new Set(entry.unknownFields);
    if (unknown.size !== entry.unknownFields.length) {
      context.addIssue({ code: 'custom', path: ['unknownFields'], message: 'Must be unique' });
    }
    optionalKnowledgeFields.forEach((field) => {
      const present = entry[field] !== undefined;
      if (present === unknown.has(field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: present
            ? 'Known fields cannot also be marked unknown'
            : 'Missing fields must be explicitly marked unknown'
        });
      }
    });
  });

export const characterKnowledgeBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    knowledgeVersion: z.string().trim().min(1).max(80),
    updatedAt: z.iso.datetime({ offset: true }),
    coverage: z
      .object({
        characterCount: z.number().int().min(0).max(256),
        notes: z.string().trim().min(1).max(500)
      })
      .strict(),
    characters: z.array(characterKnowledgeEntrySchema).max(256)
  })
  .strict()
  .superRefine(({ characters, coverage }, context) => {
    const ids = characters.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['characters'], message: 'IDs must be unique' });
    }
    if (coverage.characterCount !== characters.length) {
      context.addIssue({
        code: 'custom',
        path: ['coverage', 'characterCount'],
        message: 'Coverage count must match entries'
      });
    }
  });

export const ALL_CHARACTER_KNOWLEDGE_FIELDS = characterKnowledgeFieldSchema.options;

export type CharacterKnowledgeField = z.infer<typeof characterKnowledgeFieldSchema>;
export type CharacterCapability = z.infer<typeof characterCapabilitySchema>;
export type WeaponType = z.infer<typeof weaponTypeSchema>;
export type CharacterKnowledgeEntry = z.infer<typeof characterKnowledgeEntrySchema>;
export type CharacterKnowledgeBundle = z.infer<typeof characterKnowledgeBundleSchema>;
export type CharacterKnowledgeLookup =
  | (CharacterKnowledgeEntry & { status: 'known'; knowledgeVersion: string })
  | {
      status: 'unknown';
      id: string;
      knowledgeVersion: string;
      unknownFields: CharacterKnowledgeField[];
    };

export interface CharacterKnowledgeReader {
  readonly version: string;
  readonly coverage: CharacterKnowledgeBundle['coverage'];
  lookup(characterId: string): CharacterKnowledgeLookup;
  coverageFor(characterIds: string[]): {
    knowledgeVersion: string;
    requested: number;
    known: number;
    unknownCharacterIds: string[];
  };
}
