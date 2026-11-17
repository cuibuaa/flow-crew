const fixtures = process.env.FLOWCREW_PRIVATE_FIXTURES;
await import('../setup.js');
if (fixtures !== undefined) process.env.FLOWCREW_PRIVATE_FIXTURES = fixtures;
export {};
