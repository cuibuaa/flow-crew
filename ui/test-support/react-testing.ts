// Public root specs import through this repository-local bridge so package
// resolution stays anchored to the UI package's React 18 dependency graph.
export { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
