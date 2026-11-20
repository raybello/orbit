# Engine tab sign-in terminal, live checks

The desktop stack, rebuilt from this branch. The test account `e2e-orgo-removal@orbit.test` and its primary Bot. Headless Chromium drove the real web UI, which is what the desktop window renders.

1. Engine tab, "Sign in to a subscription…". It opens the "Choose a model for Atlas" dialog. Hermes' `model` chooser runs in the stack's API container with that agent's `HERMES_HOME`, and lists the providers with Anthropic "currently active" (`claude-signin.png`).
2. ArrowDown moves Hermes' selection from Anthropic to OpenAI (`model-chooser.png`).
3. Escape reaches Hermes, which cancels and finishes. The dialog stays open until Done or Close.
4. Closing the dialog ends the session.

Not done here: completing an OAuth sign-in. That needs the owner's own subscription account.
