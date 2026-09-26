import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Layer } from "effect";

import { ApplicationLive } from "./Application.ts";

ApplicationLive.pipe(Layer.launch, NodeRuntime.runMain);
