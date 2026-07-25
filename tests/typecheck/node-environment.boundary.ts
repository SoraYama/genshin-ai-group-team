// This file is compiled by tsconfig.node.json. If DOM globals leak into the
// main/shared type boundary, this directive becomes unused and typecheck fails.
// @ts-expect-error The pure Node type environment must not provide document.
void document;
