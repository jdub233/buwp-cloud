# buwp-cloud

Command-line tools for operating Boston University's WordPress clusters on AWS ECS.

`buwp-cloud` is the companion to [`buwp-local`](https://www.npmjs.com/package/@bostonuniversity/buwp-local):
- `buwp-local` runs the BU WordPress container on your laptop.
- `buwp-cloud` reaches the copies of that container running in the cloud. It runs wp-cli and
  shells, copies files, reads logs and opens a database tunnel.

This is an operational toolkit for working with running WordPress clusters on AWS, specifically those deployed with [`bu-wp-ecs`](https://github.com/bu-ist/bu-wp-ecs).

## Requirements

- Node.js 22 or later.
- AWS CLI v2.
- The AWS CLI's [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html),
  version 1.2.553.0 or later, for `shell`, `exec`, `cp` and `db tunnel`.
- AWS credentials for the accounts the clusters run in, as named profiles.
  - However you get them (SSO, a SAML-to-STS tool, keys), `buwp-cloud` uses them the way the AWS
    CLI does.
  - It never stores them.

## Install

Install a release from GitHub, globally:

```bash
npm install -g github:jdub233/buwp-cloud#v0.1.0
```

The examples here run `buwp-cloud` as a global command. If you install it into a project instead
(`npm install --save-dev github:jdub233/buwp-cloud#v0.1.0`), put `npx` in front of each one.

## Quickstart

```bash
buwp-cloud init                            # choose AWS profiles to search, and save them
buwp-cloud clusters                        # list the WordPress targets they reach
buwp-cloud status <target>                 # its service, its tasks, and which one sessions use
buwp-cloud <target> -- wp option get home  # run wp-cli in a running container
```

`init` reads the profile names in your AWS config and credentials files, never the keys or tokens.
It checks which WordPress targets each profile reaches and saves your choice to `.buwp-cloud.json`,
in the current directory or your home directory.

A target is a cluster's stack name, as `clusters` lists it. The ECS cluster and service names work
too. A target doesn't need a profile or a region: it carries the profile that found it, and its own
region.

## Commands

| Command | What it does |
|---|---|
| `init` | Choose the AWS profiles to search, and save them to a config file |
| `config` | Show the config file in effect and the profiles it resolves to (`--validate` checks it) |
| `clusters` | List the WordPress targets each profile reaches, and which are production |
| `status <target>` | Show the WordPress service, its tasks, and the task a session will use |
| `<target> -- <command>` | Run one command in a running WordPress container (`exec`) |
| `shell <target>` | Open an interactive shell in a running WordPress container |
| `cp <source> <destination>` | Copy one file into a running container, or out of one |
| `logs <target>` | Search or follow the WordPress logs: requests, PHP errors, cron and job-runner output |
| `db tunnel <target>` | Forward a local port to the target's database |
| `db password <target>` | Print the database password, to pipe into `pbcopy` |

- Every command's `--help` lists its options, with examples.
- Read commands take `--json`.
- `shell`, `exec`, `cp` (copying in) and `db tunnel` take `--print`. It shows the AWS CLI command
  and runs nothing.

### Running a command

```bash
buwp-cloud <target> -- wp option get home
buwp-cloud <target> -- wp site list --format=json | jq .
buwp-cloud <target> -- sh -c 'ls -la /tmp | tail'
```

- **No shell.** Everything after `--` runs in the container with each word as one argument. For
  pipes, globs or `;`, use `sh -c '...'`.
- **No local input.** Local stdin isn't sent.
- **Exit status.** The command's exit status comes back as `buwp-cloud`'s own.
- **A dropped session.** If the session ends before the command does, `buwp-cloud` exits 255 and
  says the status is unknown. The command may still be running in the container, so check before
  running it again.

### Hot-patching a file

```bash
buwp-cloud cp <target>:/var/www/html/wp-content/mu-plugins/site-manager/fix.php ./fix.php.orig
buwp-cloud cp --all-tasks ./fix.php <target>:/var/www/html/wp-content/mu-plugins/site-manager/fix.php
```

Copying in is checked before the file goes live:
1. The file is written beside the destination under a temporary name. It keeps the old file's owner
   and mode; a new file gets its directory's owner and mode 644.
2. Its sha256 is checked, and a `.php` file must pass `php -l`.
3. Only then is it moved into place. A file that fails a check leaves the old one untouched.

A copy is a hot patch, with limits:
- **It's temporary.** It lasts until the task is replaced, by a deploy or a scale-in.
- **Job-runner tasks** start from the image, so they don't see it.
- **More than one task.** On such a service, `cp` asks you to choose: `--task <id>` for one task,
  or `--all-tasks` for every one.
- **No backup.** `cp` reports the old file's sha256 but keeps no copy of it. Copy the original out
  first, as above.
- **Caching.** PHP's opcache can keep serving the old code for a few seconds, or until a reload if
  the target doesn't check timestamps.

### Reading logs

`logs` reads the WordPress container's log streams, by default the last 10 minutes.
- **Time window.** `--since` and `--until` take a duration (`30s`, `15m`, `2h`, `3d`) or a local
  date and time.
- **Filters.** `--grep` and `--filter-pattern` filter events, and `--task` narrows to one task,
  including a stopped job-runner task.
- **Following.** `-f` keeps printing new events.
- **Health checks.** Passing load-balancer health checks are hidden; `--health-checks` shows them.
- **Long spans.** Spans over 6 hours are slow, and `logs` warns about them.

`--sessions` searches the transcripts of shell and exec sessions instead (see
[What is logged](#what-is-logged)).

### Reaching the database

`db tunnel <target>` forwards local port 13306 (`--port` changes it) to the target's database,
through a running task.
- It waits until MySQL answers before saying the tunnel is ready.
- It then prints the user and database name for your MySQL client. Connect it to `127.0.0.1` as a
  standard connection, not SSH.
- Ctrl-C closes the tunnel.

The password isn't printed with the tunnel. `buwp-cloud db password <target> | pbcopy` copies it.

## Which task a command uses

`shell`, `exec`, `cp` and `db tunnel` borrow a task that's already running in the target's WordPress
service. They always use its `wordpress` container.
- **Which task.** `buwp-cloud` picks the oldest ready task on the current deployment and prints
  which one it chose.
- **Before you run.** `status` shows the choice in advance, and `--task <id>` pins a task.
- **Job-runner tasks** can't take a session.

A borrowed task is also serving web traffic, so keep the work light: reads, inspection, small
changes.

If the service runs a single task, `buwp-cloud` warns you: a session that runs that task out of
memory takes the site down with it.

## Production

A target is production unless its `environmentType` is `development`, `local` or `staging`. A
target with no type set counts as production. `clusters` marks which targets are production.

On a production target, `shell`, `exec`, `cp` and `db tunnel` print a red `PRODUCTION` line naming
the target and the AWS profile, then go ahead without asking. Three things guard against mistakes:
- **`--print`** shows what a command would run without running it.
- **One account per shell.** Setting `AWS_PROFILE` to a nonprod profile keeps production targets
  out of reach from that shell (see [AWS profiles](#aws-profiles)).
- **`cp`'s refusal.** `cp` won't copy into a service with more than one task until you choose
  `--task` or `--all-tasks`.

## AWS profiles

`buwp-cloud` searches the AWS profiles it's given for WordPress targets, in the AWS CLI's order:
1. `--profile <name>`, which you can repeat.
2. `AWS_PROFILE`.
3. The `profiles` list in a `.buwp-cloud.json` config file.
4. The AWS SDK's default credential chain.

List every account you work in once, in the config file. `init` writes it for you:

```json
{ "profiles": ["<nonprod profile>", "<prod profile>"] }
```

- `clusters` then lists the targets in each of those accounts: a table per profile, under the
  profile's name and account ID.
- `--profile` and `AWS_PROFILE` narrow the search to one account.
- `buwp-cloud config` shows which file is in effect and which profiles it resolves to.

When a profile's credentials expire, `clusters` and `init` say so. Refresh them the way you got
them, then run the command again.

### Where the config file lives

The config follows wp-env's pattern:
- **The nearest file wins.** `buwp-cloud` uses the nearest `.buwp-cloud.json`, walking up from the
  current directory.
  - A repo that uses `buwp-cloud` can commit its own.
  - `~/.buwp-cloud.json` covers everywhere else under your home directory.
- **Personal differences.** A `.buwp-cloud.override.json` next to it holds them, and its settings
  win over the shared file. Keep it out of git.
- **One file explicitly.** `BUWP_CLOUD_CONFIG` names a file and skips the search.

The file names AWS profiles, so keep it out of public repos. From its menus, `init` warns you when
the file it saves isn't gitignored.

## What is logged

- What a `shell` or `exec` session prints is kept in the cluster's log group. `logs --sessions`
  searches it.
- CloudTrail keeps each command you run, with its arguments, under your AWS identity.
- So don't print a secret in a session, or pass one as an argument. `db password` reads the database
  password on your machine instead.

## Troubleshooting

- **A command hangs instead of failing.** You're probably on a network that's connected but not
  answering, such as a dropped VPN. Press Ctrl-C and check the connection.
- **`init` and `clusters` show expired or invalid credentials.** Refresh that profile's credentials.
- **`shell`, `exec`, `cp` or `db tunnel` can't start a session.** Check that the Session Manager
  plugin is installed; `init` reports both tools' versions.
