export function simulationSource(source: string | undefined): boolean {
  return Boolean(source && /(?:^|[:/_.-])(?:mock|test|fixture|simulation|simulated)(?:$|[:/_.-])/iu.test(source));
}
