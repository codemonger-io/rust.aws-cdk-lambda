import * as cdk from 'aws-cdk-lib';
import { AssetHashType, AssetStaging, DockerRunOptions } from 'aws-cdk-lib';
import {
    Architecture,
    AssetCode,
    Code,
    Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Settings } from '.';
import { createBuildCommand } from './build';
import { getCargoLambdaVersion } from './utils';

/**
 * Options for bundling
 */
export interface BundlingProps extends DockerRunOptions {
    /**
     * Determines how the asset hash is calculated.
     *
     * @remarks
     *
     * This property is set to `AssetHashType.SOURCE` to prevent the costly Rust
     * compiler from running when there is no change in the source files.
     *
     * If your asset depends on files outside `entity`, you have to specify
     * a type other than `AssetHashType.SOURCE`.
     *
     * @default - {@link https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.AssetHashType.html#source | AssetHashType.SOURCE}
     */
    readonly assetHashType?: AssetHashType;

    /**
     * Custom asset hash.
     *
     * @remarks
     *
     * This property is meaningful if and only if `assetHashType` is
     * `AssetHashType.CUSTOM`.
     */
    readonly assetHash?: string;

    /**
     * Path to the directory that contains the project to be built; i.e., the
     * directory containing `Cargo.toml`.
     */
    readonly entry: string;

    /**
     * Executable name.
     */
    readonly bin?: string;

    /**
     * The runtime of the lambda function
     */
    readonly runtime: Runtime;

    /**
     * The system architecture of the lambda function
     */
    readonly architecture: Architecture;

    /**
     * Target of `cargo build`.
     */
    readonly target: string;

    /**
     * Key-value pairs that are passed in at compile time, i.e. to `cargo
     * build` or `cargo lambda`.
     *
     * Use environment variables to apply configuration changes, such
     * as test and production environment configurations, without changing your
     * Lambda function source code.
     *
     * @default - No environment variables.
     */
    readonly buildEnvironment?: { [key:string]: string };

    /**
     * Forces bundling in a Docker container even if local bundling is possible.
     *
     * @default - false
     */
    readonly forcedDockerBundling?: boolean;
}

/**
 * Bundling
 */
export class Bundling implements cdk.BundlingOptions {
    public static bundle(options: BundlingProps): AssetCode {
        const bundling = new Bundling(options);

        return Code.fromAsset(options.entry, {
            assetHashType: options.assetHashType ?? AssetHashType.SOURCE,
            assetHash: options.assetHash,
            bundling: {
                image: bundling.image,
                command: bundling.command,
                environment: bundling.environment,
                local: bundling.local,
                user: bundling.user,
            },
        });
    }

    // Whether `cargo lambda` is available.
    private static runsLocally?: boolean;

    // Core bundling options
    public readonly image: cdk.DockerImage;
    public readonly command: string[];
    public readonly environment?: { [key:string]: string };
    public readonly user: string;
    public readonly local?: cdk.ILocalBundling;

    constructor(private readonly props: BundlingProps) {
        Bundling.runsLocally = Bundling.runsLocally
            ?? getCargoLambdaVersion()
            ?? false;

        const inputEnv = props.buildEnvironment || Settings.BUILD_ENVIRONMENT;

        // Docker bundling
        // reference: https://github.com/aws/aws-cdk/blob/9bd507842f567ee3e450c3f44e5c3dccc7c42ae6/packages/%40aws-cdk/aws-lambda-go/lib/bundling.ts#L143-L165
        const shouldBuildImage = props.forcedDockerBundling || !Bundling.runsLocally;
        this.image = shouldBuildImage
            ? cdk.DockerImage.fromBuild(path.join(__dirname, '../lib'), {
                // intentionally omits the platform to always use the native
                // platform. the platform does not matter because cargo supports
                // cross compilation.
            })
            : cdk.DockerImage.fromRegistry('dummy');
        this.command = [
            'bash',
            '-c',
            createBuildCommand({
                entry: AssetStaging.BUNDLING_INPUT_DIR,
                bin: props.bin,
                target: props.target,
                outDir: AssetStaging.BUNDLING_OUTPUT_DIR,
                targetPlatform: 'linux',
            }),
        ];
        this.environment = inputEnv;
        this.user = 'root';

        // Local bundling
        if (!props.forcedDockerBundling) {
            const osPlatform = os.platform();
            this.local = {
                // reference: https://github.com/aws/aws-cdk/blob/1ca3e0027323e84aacade4d9bd058bbc5687a7ab/packages/%40aws-cdk/aws-lambda-go/lib/bundling.ts#L174-L199
                tryBundle(outDir: string) {
                    if (Bundling.runsLocally == false) {
                        process.stderr.write('cargo lambda cannot run locally. Switching to Docker bundling.\n');
                        return false;
                    }
                    console.log(`BUNDLING...: ${outDir}`);
                    const buildCommand = createBuildCommand({
                        entry: props.entry,
                        bin: props.bin,
                        target: props.target,
                        outDir,
                        targetPlatform: osPlatform,
                    });
                    console.log('Running:', buildCommand);
                    const cargo = spawnSync(
                        osPlatform === 'win32' ? 'cmd' : 'bash',
                        [
                            osPlatform === 'win32' ? '/c' : '-c',
                            buildCommand,
                        ],
                        {
                            env: { ...process.env, ...inputEnv ?? {} },
                            cwd: props.entry,
                            windowsVerbatimArguments: osPlatform === 'win32',
                        },
                    );
                    if (cargo.status !== 0) {
                        console.error(cargo.stderr.toString().trim());
                        console.error(`💥  Run \`cargo lambda\` errored.`);
                        process.exit(1);
                    }
                    return true;
                },
            };
        }
    }
}
