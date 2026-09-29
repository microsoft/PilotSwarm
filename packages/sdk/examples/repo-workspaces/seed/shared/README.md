# The shared folder

Every session of every person can read and write this folder. Use it to hand
files to other people.

- Put your files in a folder named for the topic, with a line in its
  README.md saying who you are and when you added it.
- Do not delete or change other people's files.
- `.github/` holds agents and skills anyone can load, for example:
  `load_agent({ path: "/ws/shared/.github/agents/reviewer.agent.md" })` and
  `load_skill({ path: "/ws/shared/.github/skills/share-a-file" })`.
  They are read-only here; copy one into your own folder to change it.
