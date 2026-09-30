// This fixture is produced and compared by TestBoardJSONContract in Go.
// Assignment checks value types; recursive key comparison also catches added,
// removed or renamed fields that ordinary structural assignment would ignore.
import fixture from '../../tests/fixtures/board.json';

const board: Flux.Board = fixture;
void board;

type FieldDrift<Expected, Actual> = [Expected] extends [readonly (infer E)[]]
  ? [Actual] extends [readonly (infer A)[]]
    ? FieldDrift<NonNullable<E>, NonNullable<A>>
    : 'array type'
  : [Expected] extends [object]
    ? [Actual] extends [object]
      ?
          | Exclude<keyof Expected, keyof Actual>
          | Exclude<keyof Actual, keyof Expected>
          | {
              [K in keyof Expected & keyof Actual]: FieldDrift<
                NonNullable<Expected[K]>,
                NonNullable<Actual[K]>
              >;
            }[keyof Expected & keyof Actual]
      : 'object type'
    : [Actual] extends [Expected]
      ? never
      : 'value type';

type AssertNoDrift<T extends never> = T;
export type BoardContract = AssertNoDrift<FieldDrift<Flux.Board, typeof fixture>>;

// Negative controls ensure the guard itself cannot become a permissive check.
// @ts-expect-error Added JSON fields must be declared in Flux.Board.
type AddedField = AssertNoDrift<FieldDrift<Flux.Board, typeof fixture & { unexpected: string }>>;
// @ts-expect-error Removed JSON fields must also update Flux.Board.
type RemovedField = AssertNoDrift<FieldDrift<Flux.Board, Omit<typeof fixture, 'items'>>>;
type ChangedItemShape = Omit<(typeof fixture.items)[0], 'title'> & { title: number };
// @ts-expect-error Nested value type changes must fail the contract check.
type ChangedItem = AssertNoDrift<FieldDrift<Flux.Item, ChangedItemShape>>;
export type NegativeControls = [AddedField, RemovedField, ChangedItem];
