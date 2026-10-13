import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const {client, context, core} = vi.hoisted(() => ({
  client: {
    rest: {pulls: {get: vi.fn(), listCommits: vi.fn()}},
    paginate: {iterator: vi.fn()},
    request: vi.fn()
  },
  context: {
    actor: 'aa-ci-bot[bot]',
    payload: {
      pull_request: {
        number: 1,
        base: {user: {login: 'vc-vantage'}, repo: {name: 'vantage-configs'}}
      }
    }
  },
  core: {info: vi.fn(), setFailed: vi.fn(), setOutput: vi.fn()}
}));

vi.mock('@actions/core', () => core);
vi.mock('@actions/github', () => ({context, getOctokit: () => client}));

const releasePr = {
  title: ":tada: Uat: Bump vantage/service (tag '1.0.0' to '2.0.0')",
  user: {login: 'github-actions[bot]', type: 'Bot'},
  base: {ref: 'main', repo: {full_name: 'vc-vantage/vantage-configs'}},
  head: {
    ref: 'release/uat-service/2.0.0',
    sha: 'head-sha',
    repo: {full_name: 'vc-vantage/vantage-configs'}
  }
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  vi.stubEnv('INPUT_WIP', 'true');
  vi.stubEnv('INPUT_VALIDATESINGLECOMMIT', 'true');
  vi.stubEnv('INPUT_VALIDATESINGLECOMMITMATCHESPRTITLE', 'true');
  vi.stubEnv(
    'INPUT_SUBJECTPATTERN',
    '^(.*(VPM|PENG|VANSUP|AADA|AAA|SMBP|AUTOQA|AD)-[1-9][0-9]{0,5}.*|bump .*)$'
  );
  client.rest.pulls.get.mockResolvedValue({data: structuredClone(releasePr)});
  client.paginate.iterator.mockReturnValue([
    {
      data: [
        {parents: [{sha: 'base-sha'}], commit: {message: ':tada: Bump service'}}
      ]
    }
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([
  ['github-actions[bot]', 'uat-service', releasePr.title],
  ['github-actions[bot]', 'prod-service', ':tada: Prod: Bump vantage/service'],
  [
    'aa-ci-bot[bot]',
    'uat-workflow-service',
    ':tada: Uat: Bump vantage-workflow/service'
  ],
  [
    'aa-ci-bot[bot]',
    'prod-workflow-service',
    ':tada: Prod: Bump vantage-workflow/service'
  ]
])('exempts generated releases by %s on %s', async (login, branch, title) => {
  client.rest.pulls.get.mockResolvedValue({
    data: {
      ...releasePr,
      title,
      user: {login, type: 'Bot'},
      head: {...releasePr.head, ref: `release/${branch}/2.0.0`}
    }
  });

  await import('./index.js');

  expect(core.setFailed).not.toHaveBeenCalled();
  expect(core.info).toHaveBeenCalledWith(
    expect.stringContaining('Generated configs release')
  );
  expect(client.paginate.iterator).not.toHaveBeenCalled();
  expect(client.request).toHaveBeenCalledWith(
    'POST /repos/:owner/:repo/statuses/:sha',
    expect.objectContaining({sha: 'head-sha', state: 'success'})
  );
});

it.each([
  ['human author', {user: {login: 'developer', type: 'User'}}],
  ['non-bot identity', {user: {login: 'github-actions[bot]', type: 'User'}}],
  ['unknown bot', {user: {login: 'another-app[bot]', type: 'Bot'}}],
  ['missing author', {user: null}],
  [
    'another repository',
    {base: {...releasePr.base, repo: {full_name: 'vc-vantage/other'}}}
  ],
  ['another target', {base: {...releasePr.base, ref: 'alpha'}}],
  [
    'fork',
    {head: {...releasePr.head, repo: {full_name: 'developer/vantage-configs'}}}
  ],
  ['deleted fork', {head: {...releasePr.head, repo: null}}],
  [
    'unrelated branch',
    {head: {...releasePr.head, ref: 'feat/vpm-11651_example'}}
  ],
  ['dev branch', {head: {...releasePr.head, ref: 'release/dev-service/2.0.0'}}],
  ['missing project', {head: {...releasePr.head, ref: 'release/uat-/2.0.0'}}],
  ['missing version', {head: {...releasePr.head, ref: 'release/uat-service/'}}],
  [
    'extra branch segment',
    {head: {...releasePr.head, ref: 'release/uat-service/2.0.0/extra'}}
  ]
])(
  'still validates a release-shaped PR with %s',
  async (description, changes) => {
    client.rest.pulls.get.mockResolvedValue({data: {...releasePr, ...changes}});

    await import('./index.js');

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('No release type found')
    );
    expect(client.request).toHaveBeenCalledWith(
      'POST /repos/:owner/:repo/statuses/:sha',
      expect.objectContaining({state: 'pending'})
    );
  }
);

it('keeps WIP releases pending without validating their messages', async () => {
  client.rest.pulls.get.mockResolvedValue({
    data: {...releasePr, title: `[WIP] ${releasePr.title}`}
  });

  await import('./index.js');

  expect(core.setFailed).not.toHaveBeenCalled();
  expect(client.paginate.iterator).not.toHaveBeenCalled();
  expect(client.request).toHaveBeenCalledWith(
    'POST /repos/:owner/:repo/statuses/:sha',
    expect.objectContaining({
      state: 'pending',
      description: 'This PR is marked with "[WIP]".'
    })
  );
});

it('continues validating the single commit of an ordinary PR', async () => {
  client.rest.pulls.get.mockResolvedValue({
    data: {
      ...releasePr,
      title: 'feat: Add a capability (VPM-11651)',
      user: {login: 'developer', type: 'User'}
    }
  });

  await import('./index.js');

  expect(client.paginate.iterator).toHaveBeenCalledOnce();
  expect(core.setFailed).toHaveBeenCalledWith(
    expect.stringContaining("only one commit and it's not semantic")
  );
});
