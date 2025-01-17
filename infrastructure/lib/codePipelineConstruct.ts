/** *******************************************************************************************************************
Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                                                                              *
 ******************************************************************************************************************** */
import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as iam from '@aws-cdk/aws-iam';
import * as sns from '@aws-cdk/aws-sns';
import * as codecommit from '@aws-cdk/aws-codecommit';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as codepipeline_actions from '@aws-cdk/aws-codepipeline-actions';

export type CodePipelineConstructProps = {
    readonly dataManifestBucket: s3.Bucket;
    readonly sageMakerArtifactBucket: s3.Bucket;
    readonly sageMakerExecutionRole: iam.Role;
    readonly projectName: string;
} & (CodePipelineConstructPropsGithubSource | CodePipelineConstructPropsCodeCommitSource);

export interface CodePipelineConstructPropsCodeCommitSource {
    readonly repoType: 'codecommit';
}

export interface CodePipelineConstructPropsGithubSource {
    readonly repoType: 'git';
    readonly git: {
        readonly githubConnectionArn: string;
        readonly githubRepoOwner: string;
        readonly githubRepoName: string;
        readonly githubRepoBranch?: string;
    };
}

/**
 * The CDK Construct provisions the code pipeline construct.
 */
export class CodePipelineConstruct extends cdk.Construct {
    readonly pipeline: codepipeline.Pipeline;
    constructor(scope: cdk.Construct, id: string, props: CodePipelineConstructProps) {
        super(scope, id);

        this.pipeline = new codepipeline.Pipeline(this, 'MLOpsPipeline', {
            restartExecutionOnUpdate: true,
        });

        const sourceCodeOutput = new codepipeline.Artifact('SourceCodeOutput');
        const sourceDataOutput = new codepipeline.Artifact('SourceDataOutput');
        const buildOutput = new codepipeline.Artifact('BuildOutput');
        const pipelineOutput = new codepipeline.Artifact('PipelineOutput');

        let sourceCode: codepipeline_actions.Action;

        //Source Code
        if (props.repoType === 'git') {
            sourceCode = new codepipeline_actions.CodeStarConnectionsSourceAction({
                actionName: 'SourceCode',
                output: sourceCodeOutput,
                owner: props.git.githubRepoOwner,
                repo: props.git.githubRepoName,
                branch: props.git.githubRepoBranch || 'main',
                connectionArn: props.git.githubConnectionArn,
            });
        } else {
            const sourceRepo = new codecommit.Repository(this, 'SourceRepository', {
                repositoryName: 'MLOpsE2EDemo',
            });
            sourceCode = new codepipeline_actions.CodeCommitSourceAction({
                actionName: 'SourceCode',
                output: sourceCodeOutput,
                repository: sourceRepo,
                branch: 'main',
            });
        }

        //Source Data
        const sourceData = new codepipeline_actions.S3SourceAction({
            actionName: 'SourceData',
            output: sourceDataOutput,
            bucket: props.dataManifestBucket,
            bucketKey: 'manifest.json.zip',
        });

        this.pipeline.addStage({
            stageName: 'Source',
            actions: [sourceCode, sourceData],
        });

        //CI
        const buildProject = new codebuild.PipelineProject(this, 'CIBuild', {
            buildSpec: codebuild.BuildSpec.fromSourceFilename('./buildspecs/build.yml'),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
                privileged: true
            },
        });

        const build = new codepipeline_actions.CodeBuildAction({
            actionName: 'CIBuild',
            project: buildProject,
            input: sourceCodeOutput,
            extraInputs: [sourceDataOutput],
            outputs: [buildOutput],
        });

        this.pipeline.addStage({
            stageName: 'CI',
            actions: [build],
        });

        //MLPipeline
        const mlPipelineRole = new iam.Role(this, 'MLPipelineRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
        });

        mlPipelineRole.addToPolicy(
            iam.PolicyStatement.fromJson({
                Effect: 'Allow',
                Action: ['s3:CreateBucket', 's3:GetObject', 's3:PutObject', 's3:ListBucket'],
                Resource: [props.sageMakerArtifactBucket.bucketArn, `${props.sageMakerArtifactBucket.bucketArn}/*`],
            })
        );

        mlPipelineRole.addToPolicy(
            iam.PolicyStatement.fromJson({
                Effect: 'Allow',
                Action: [
                    'sagemaker:CreatePipeline',
                    'sagemaker:ListTags',
                    'sagemaker:AddTags',
                    'sagemaker:UpdatePipeline',
                    'sagemaker:DescribePipeline',
                    'sagemaker:StartPipelineExecution',
                    'sagemaker:DescribePipelineExecution',
                    'sagemaker:ListPipelineExecutionSteps',
                ],
                Resource: [
                    `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:pipeline/${
                        props.projectName
                    }`,
                    `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:pipeline/${
                        props.projectName
                    }/*`,
                ],
            })
        );

        mlPipelineRole.addToPolicy(
            iam.PolicyStatement.fromJson({
                Effect: 'Allow',
                Action: ['iam:PassRole'],
                Resource: [props.sageMakerExecutionRole.roleArn],
            })
        );

        const mlPipelineProject = new codebuild.PipelineProject(this, 'MLPipeline', {
            buildSpec: codebuild.BuildSpec.fromSourceFilename('./buildspecs/pipeline.yml'),
            role: mlPipelineRole,
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
            },
        });

        const mlPipelie = new codepipeline_actions.CodeBuildAction({
            actionName: 'MLPipeline',
            project: mlPipelineProject,
            input: buildOutput,
            outputs: [pipelineOutput],
            environmentVariables: {
                SAGEMAKER_ARTIFACT_BUCKET: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: props.sageMakerArtifactBucket.bucketName,
                },
                SAGEMAKER_PIPELINE_ROLE_ARN: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: props.sageMakerExecutionRole.roleArn,
                },
                SAGEMAKER_PROJECT_NAME: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: props.projectName,
                },
            },
        });

        this.pipeline.addStage({
            stageName: 'MLPipeline',
            actions: [mlPipelie],
        });

        //Deploy
        const deploymentApprovalTopic = new sns.Topic(this, 'ModelDeploymentApprovalTopic', {
            topicName: 'ModelDeploymentApprovalTopic',
        });

        const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approval',
            runOrder: 1,
            notificationTopic: deploymentApprovalTopic,
            additionalInformation: `A new version of the model for project ${props.projectName} is waiting for approval`,
            externalEntityLink: `https://${cdk.Stack.of(this).region}.console.aws.amazon.com/sagemaker/home?region=${
                cdk.Stack.of(this).region
            }#/studio/`,
        });

        const deployRole = new iam.Role(this, 'DeployRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
        });

        deployRole.addToPolicy(
            new iam.PolicyStatement({
                conditions: {
                    "ForAnyValue:StringEquals": {
                        "aws:CalledVia": [
                            "cloudformation.amazonaws.com"
                        ]
                    }
                },
                actions: [ 
                    'lambda:*Function*'
                ],
                resources: [
                    `arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:Deployment-${props.projectName}*`
                ],
            })
        );

        deployRole.addToPolicy(
            new iam.PolicyStatement({
                conditions: {
                    "ForAnyValue:StringEquals": {
                        "aws:CalledVia": [
                            "cloudformation.amazonaws.com"
                        ]
                    }
                },
                actions: [ 
                    'sagemaker:*Endpoint*'
                ],
                resources: [
                    '*'
                ],
            })
        );

        deployRole.addToPolicy(
            new iam.PolicyStatement({
                conditions: {
                    "ForAnyValue:StringEquals": {
                        "aws:CalledVia": [
                            "cloudformation.amazonaws.com"
                        ]
                    }
                },
                actions: [ 
                    'iam:*Role',
                    'iam:*Policy*',
                    'iam:*RolePolicy'
                ],
                resources: [
                    `arn:aws:iam::${cdk.Stack.of(this).account}:role/Deployment-${props.projectName}-*`
                ],
            })
        );

        deployRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [ 
                    "cloudformation:DescribeStacks",
                    "cloudformation:CreateChangeSet",
                    "cloudformation:DescribeChangeSet",
                    "cloudformation:ExecuteChangeSet",
                    "cloudformation:DescribeStackEvents",
                    "cloudformation:DeleteChangeSet",
                    "cloudformation:GetTemplate"
                ],
                resources: [
                    `arn:aws:cloudformation:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:stack/CDKToolkit/*`,
                    `arn:aws:cloudformation:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:stack/Deployment-${props.projectName}/*`
                ],
            })
        );

        deployRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [ 
                    "s3:*Object",
                    "s3:ListBucket",
                    "s3:GetBucketLocation"
                ],
                resources: ['arn:aws:s3:::cdktoolkit-stagingbucket-*'],
            })
        );

        const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
            buildSpec: codebuild.BuildSpec.fromSourceFilename('./buildspecs/deploy.yml'),
            role: deployRole,
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
                privileged: true
            },
        });

        const deploy = new codepipeline_actions.CodeBuildAction({
            actionName: 'Deploy',
            runOrder: 2,
            project: deployProject,
            input: buildOutput,
            extraInputs: [pipelineOutput],
        });

        this.pipeline.addStage({
            stageName: 'Deploy',
            actions: [manualApprovalAction, deploy],
        });
    }
}
