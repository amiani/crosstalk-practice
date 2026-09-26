# Fully automated preparation with automatic quality gates

The learner never reviews extracted or generated Finnish, because they cannot judge material they don't yet understand, so the system gates quality itself. It discards doubtful transcript passages, fails a recording with insufficient material instead of padding it with unrelated Finnish, and runs every generated batch past a second model acting as a strict native editor, dropping rejects. That review roughly doubles generation cost, which we accept because a wrong sentence drilled by ear is worse than a missing one.
