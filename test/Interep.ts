import { expect } from "chai"
import { config as dotenvConfig } from "dotenv"
import { BigNumber, Signer } from "ethers"
import { ethers, run } from "hardhat"
import { Strategy, ZkIdentity } from "@zk-kit/identity"
import { Semaphore, generateMerkleProof, SemaphoreFullProof, SemaphoreSolidityProof } from "@zk-kit/protocols"
import { resolve } from "path"
import { Interep } from "../build/typechain/Interep"
import { createTree, createIdentityCommitments } from "./utils"

dotenvConfig({ path: resolve(__dirname, "../.env") })

describe("Interep", () => {
    let contract: Interep
    let signers: Signer[]
    let accounts: string[]

    const groupId = 1
    const offchainGroupId = 2
    const members = createIdentityCommitments(3)
    const depth = 20

    const wasmFilePath = "./static/semaphore.wasm"
    const finalZkeyPath = "./static/semaphore_final.zkey"

    before(async () => {
        const { address: verifierAddress } = await run("deploy:verifier", { logs: false })
        contract = await run("deploy", { logs: false, verifiers: [[depth, verifierAddress]] })

        signers = await run("accounts", { logs: false })
        accounts = await Promise.all(signers.map((signer: Signer) => signer.getAddress()))
    })

    describe("# addOffchainGroups", () => {
        it("Should not publish new offchain groups if the parameter lists don't have the same length", async () => {
            const transaction = contract.addOffchainGroups([offchainGroupId, offchainGroupId], [{ root: 1, depth: 20 }])

            await expect(transaction).to.be.revertedWith(
                "InterepGroups: parameters lists does not have the same length"
            )
        })

        it("Should not publish an offchain group if an onchain group with the same id already exists", async () => {
            await contract.createGroup(3, depth, accounts[0])

            const transaction = contract.addOffchainGroups([3], [{ root: 1, depth: 20 }])

            await expect(transaction).to.be.revertedWith("InterepGroups: group id already exists onchain")
        })

        it("Should publish 20 new offchain roots", async () => {
            const groupIds: number[] = []
            const offchainGroups: any[] = []

            for (let i = 0; i < 20; i++) {
                groupIds.push(offchainGroupId)
                offchainGroups.push({
                    root: i,
                    depth
                })
            }

            const transaction = contract.addOffchainGroups(groupIds, offchainGroups)

            await expect(transaction)
                .to.emit(contract, "OffchainGroupAdded")
                .withArgs(offchainGroupId, offchainGroups[0].root, offchainGroups[0].depth)
            expect((await (await transaction).wait()).events).to.length(20)
        })
    })

    describe("# getOffchainRoot", () => {
        it("Should get the tree root of an offchain group", async () => {
            const root = await contract.getOffchainRoot(offchainGroupId)

            expect(root).to.equal(19)
        })
    })

    describe("# getOffchainDepth", () => {
        it("Should get the tree depth of an offchain group", async () => {
            const root = await contract.getOffchainDepth(offchainGroupId)

            expect(root).to.equal(depth)
        })
    })

    describe("# createGroup", () => {
        it("Should create a group", async () => {
            const transaction = contract.createGroup(groupId, depth, accounts[0])

            await expect(transaction).to.emit(contract, "GroupAdded").withArgs(groupId, depth)
        })
    })

    describe("# addMember", () => {
        it("Should not add a member if the caller is not the group admin", async () => {
            const member = BigInt(2)

            const transaction = contract.connect(signers[1]).addMember(groupId, member)

            await expect(transaction).to.be.revertedWith("InterepGroups: caller is not the group admin")
        })

        it("Should add a new member in an existing group", async () => {
            const transaction = contract.addMember(groupId, members[0])

            await expect(transaction)
                .to.emit(contract, "MemberAdded")
                .withArgs(
                    groupId,
                    members[0],
                    "8430290810815993763936320875702691044009457941353977969924088162842849710651"
                )
        })
    })

    describe("# removeMember", () => {
        it("Should not remove a member if the caller is not the group admin", async () => {
            const transaction = contract.connect(signers[1]).removeMember(groupId, members[0], [0, 1], [0, 1])

            await expect(transaction).to.be.revertedWith("InterepGroups: caller is not the group admin")
        })

        it("Should remove a member from an existing group", async () => {
            const groupId = ethers.utils.formatBytes32String("hello")
            const tree = createTree(depth, 3)

            tree.delete(0)

            await contract.createGroup(groupId, depth, accounts[0])
            await contract.addMember(groupId, BigInt(1))
            await contract.addMember(groupId, BigInt(2))
            await contract.addMember(groupId, BigInt(3))

            const { siblings, pathIndices, root } = tree.createProof(0)

            const transaction = contract.removeMember(
                groupId,
                BigInt(1),
                siblings.map((s) => s[0]),
                pathIndices
            )

            await expect(transaction).to.emit(contract, "MemberRemoved").withArgs(groupId, BigInt(1), root)
        })
    })

    describe("# verifyProof", () => {
        const signal = "Hello world"
        const identity = new ZkIdentity(Strategy.MESSAGE, "0")
        const identityCommitment = identity.genIdentityCommitment()
        const zeroValue = BigNumber.from(ethers.utils.solidityKeccak256(["string"], ["Semaphore"])).toBigInt()
        const merkleProof = generateMerkleProof(depth, zeroValue, 2, members, identityCommitment)
        const witness = Semaphore.genWitness(
            identity.getTrapdoor(),
            identity.getNullifier(),
            merkleProof,
            merkleProof.root,
            signal
        )

        let fullProof: SemaphoreFullProof
        let solidityProof: SemaphoreSolidityProof

        before(async () => {
            await contract.addMember(groupId, members[1])
            await contract.addMember(groupId, members[2])

            fullProof = await Semaphore.genProof(witness, wasmFilePath, finalZkeyPath)
            solidityProof = Semaphore.packToSolidityProof(fullProof)
        })

        it("Should not verify a proof if the group does not exist", async () => {
            const transaction = contract.verifyProof(10, "", 0, 0, [0, 0, 0, 0, 0, 0, 0, 0])

            await expect(transaction).to.be.revertedWith("Interep: the group does not exist")
        })

        it("Should throw an exception if the proof is not valid", async () => {
            const transaction = contract.verifyProof(
                groupId,
                signal,
                fullProof.publicSignals.nullifierHash,
                0,
                solidityProof
            )

            await expect(transaction).to.be.revertedWith("Interep: the proof is not valid")
        })

        it("Should verify a proof for an onchain group correctly", async () => {
            const transaction = contract.verifyProof(
                groupId,
                signal,
                fullProof.publicSignals.nullifierHash,
                fullProof.publicSignals.merkleRoot,
                solidityProof
            )

            await expect(transaction).to.emit(contract, "ProofVerified").withArgs(groupId, signal)
        })
    })
})
