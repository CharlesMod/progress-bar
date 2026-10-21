# progress-bar

A Claude Code mod that draws a slim progress bar in the prompt footer, showing Claude's own running estimate of how far along your latest request is. It's made for long requests that run 10 to 40 minutes.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install progress-bar --marketplace CharlesMod/progress-bar
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it load in every session, the desktop app's local sessions included).

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `CharlesMod/progress-bar`, then **Add plugin**.

Requires Claude Code 2.1.299 or newer.

## How it works

- A short system-prompt section asks Claude to tag each status update with its estimate for the whole request, such as `[D20.9%]`. The estimate can rise or fall, and the final message ends with `[D100%]`. Quick questions that need no work get no tag.
- The mod reads the last tag in each of Claude's messages and redraws the bar. Subagents' messages are ignored.
- A new request clears the bar until its first estimate. A finished request turns the bar green at 100%. An interrupted one keeps its last value, marked `· stopped`.
- In the desktop app it's a rounded gradient bar. In a terminal it's a 16-cell block bar that fills in eighths.

Note: a mod's system-prompt hook does not run where an organization manages Claude Code, unless that organization lists the plugin in its managed settings.

## Develop

```
claude plugin validate .
claude plugin test .
```
