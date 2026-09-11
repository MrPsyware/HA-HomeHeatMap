export function findFloor(floors, value) {
  if (!value) return undefined;
  return floors.find(f => f.id === value)
    || floors.find(f => f.name.trim().toLowerCase() === value.trim().toLowerCase());
}
