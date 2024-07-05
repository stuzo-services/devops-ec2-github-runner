const { EC2, waitUntilInstanceRunning } = require('@aws-sdk/client-ec2');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.299.1/actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

function buildMarketOptions() {
  if (config.input.marketType === 'spot') {
    return {
      MarketType: config.input.marketType,
      SpotOptions: {
        SpotInstanceType: 'one-time',
      },
    };
  }

  return undefined;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new EC2();
  const userData = buildUserDataScript(githubRegistrationToken, label);

  const instanceTypes = JSON.parse(config.input.ec2InstanceTypes);

  for (const instanceType of instanceTypes) {
    const params = {
      ImageId: config.input.ec2ImageId,
      InstanceType: instanceType,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(userData.join('\n')).toString('base64'),
      SubnetIds: JSON.parse(config.input.subnetIds),
      SecurityGroupIds: [config.input.securityGroupId],
      IamInstanceProfile: { Name: config.input.iamRoleName },
      TagSpecifications: config.tagSpecifications,
      InstanceMarketOptions: buildMarketOptions(),
    };

    try {
      const result = await ec2.runInstances(params);
      const ec2InstanceId = result.Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} of type ${instanceType} is started`);
      return ec2InstanceId;
    } catch (error) {
      if (error.code === 'InsufficientInstanceCapacity') {
        core.warning(`Insufficient capacity for instance type ${instanceType}, trying next type...`);
      } else {
        core.error('AWS EC2 instance starting error');
        throw error;
      }
    }
  }

  throw new Error('Failed to start EC2 instance due to insufficient capacity for all tried instance types.');
}

async function terminateEc2Instance() {
  const ec2 = new EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params);
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await waitUntilInstanceRunning({
      client: ec2,
      maxWaitTime: 200,
    }, params);
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
