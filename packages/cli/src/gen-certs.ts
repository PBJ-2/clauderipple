#!/usr/bin/env node
// Dev helper until `clauderipple install` exists: generate CA + leaf into CLAUDERIPPLE_HOME.
import { generateCerts } from "./certs.ts";
import { homeDir } from "../../router/src/config.ts";

const home = homeDir();
const p = generateCerts(home);
console.log(`certs written to ${home}: ${Object.values(p).map((f) => f.split("/").pop()).join(", ")}`);
