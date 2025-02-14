import { Vault } from "../typechain/Vault";
import {ERC20} from "typechain/ERC20";
import { ethers } from "hardhat";
import { Signer, BigNumber, BigNumberish, BytesLike } from "ethers";
import * as readline from "readline-sync";
import {Tranche} from "../typechain/Tranche";
import {ERC20__factory} from "../typechain/factories/ERC20__factory";
import {bnFloatMultiplier, fmtFloat} from "./math";

async function neededBonds(
    initialBase: BigNumber,
    expectedApy: number,
    timeStretch: number,
    trancheLength: number,
  ) {
    const t = trancheLength/timeStretch;
    const rho = Math.pow(1 - expectedApy*trancheLength, 1/-t);
    return bnFloatMultiplier(bnFloatMultiplier(initialBase, (rho - 1) ), 1 / (1 + rho));
  }

async function gasPrice() {
    const gas = readline.question("gas price: ");
    return ethers.utils.parseUnits(gas, 'gwei');
}


const JOIN_WEIGHTED_POOL_INIT_TAG = 0;
export function encodeJoinWeightedPool(amountsIn: BigNumberish[]): string {
    return ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256[]"],
      [JOIN_WEIGHTED_POOL_INIT_TAG, amountsIn]
    );
}

  // Note - we assume that 1 - ytPrice = fytPrice, which is only valid at tranche start
export async function initYieldPool(
    signer: Signer,
    vault: Vault,
    tranche: Tranche,
    token: ERC20,
    ytPoolId: BytesLike,
    term: number,
    expectedAPY: number,
  ) {
    console.log("Attempting to initialize lp pool");
    // Load the yield token and cast it's address as erc20
    const yieldTokenAddr = await tranche.interestToken();
    const ERC20Factory = new ERC20__factory(signer);
    const yieldToken = ERC20Factory.attach(yieldTokenAddr);
    // Load other data
    const signerAddress = await signer.getAddress();
    const decimals = await token.decimals();
    const one = ethers.utils.parseUnits("1", decimals);
    console.log("Your token balance is : ", fmtFloat(await token.balanceOf(signerAddress), one));
    console.log("Your yt balance is : ", fmtFloat(await yieldToken.balanceOf(signerAddress), one));

    const mintMore = readline.question("do you need to deposit (y/n): ");
    if (mintMore == "y") {
        const howMuch = readline.question("how much [decimal form]: ");
        const mintAmount = bnFloatMultiplier(one, Number.parseFloat(howMuch));
        // We mint using the input amount
        if(BigNumber.from(await token.allowance(signerAddress, tranche.address)).lt(mintAmount)) {
          console.log("setting allowance");
          const gas = await gasPrice();
          let tx = await token.approve(tranche.address, ethers.constants.MaxUint256, {gasPrice: gas});
          await tx.wait(1);
        }
        console.log("Deposited into tranche");
        const gas = await gasPrice();
        let tx = await tranche.connect(signer).deposit(mintAmount, signerAddress, {gasPrice: gas});
        await tx.wait(1);
        console.log("Deposit Completed");
    }

    const depositAmountStr = readline.question("Deposit amount of yt [decimal]: ");
    const depositAmount = bnFloatMultiplier(one, Number.parseFloat(depositAmountStr));

    console.log("Checking allowances");

    let txAwaits = [];
    if ((await token.allowance(signerAddress, vault.address)).lt(depositAmount)) {
        console.log("Setting unlimited allowance for underlying");
        const gas = await gasPrice();
        const tx = await token
        .connect(signer)
        .approve(vault.address, ethers.constants.MaxUint256, {gasPrice: gas});
        txAwaits.push(tx.wait(1));
    }
    if ((await yieldToken.allowance(signerAddress, vault.address)).lt(depositAmount)) {
        console.log("Setting unlimited allowance for yt");
        const gas = await gasPrice();
        let tx = await yieldToken
        .connect(signer)
        .approve(vault.address, ethers.constants.MaxUint256, {gasPrice: gas});
        txAwaits.push(tx.wait(1));
    }
    await Promise.all(txAwaits);
    console.log("Allowances completed");

    // Make the first deposit into the yield token pool, simple ratio
    let ytAssets;
    let ytAmountsIn;
    const tokenDecimals = await token.decimals();
    const ytRatio = ethers.utils.parseUnits(
      (term * expectedAPY).toFixed(tokenDecimals),
      tokenDecimals
    );
    const stakedTokenYT = depositAmount
      .mul(ytRatio)
      .div(ethers.utils.parseUnits("1", tokenDecimals));
    console.log("Depositing: ", fmtFloat(stakedTokenYT, one), " underlying");
    // We have to order these inputs
    if (BigNumber.from(yieldToken.address).lt(token.address)) {
      ytAssets = [yieldToken.address, token.address];
      // Will input quite a bit less token than yt
      ytAmountsIn = [depositAmount, stakedTokenYT];
    } else {
      ytAssets = [token.address, yieldToken.address];
      // Will input quite a bit less token than yt
      ytAmountsIn = [stakedTokenYT, depositAmount];
    }
    const gas = await gasPrice();
    console.log("try funding yt pool");
    let tx = await vault
      .connect(signer)
      .joinPool(ytPoolId, signerAddress, signerAddress, {
        assets: ytAssets,
        maxAmountsIn: ytAmountsIn,
        userData: encodeJoinWeightedPool(ytAmountsIn),
        fromInternalBalance: false
      },        
      {gasPrice: gas});
    await tx.wait(1);
    console.log("Pool funded");

  
    console.log("YT pool status", await vault.getPoolTokens(ytPoolId));
}

export async function initPtPool(
    signer: Signer,
    vault: Vault,
    tranche: Tranche,
    token: ERC20,
    ccPoolId: BytesLike,
    expectedAPY: number,
    timeStretch: number,
    trancheLength: number
  ) {
    console.log("Attempting to initialize lp pool");
    // Load the ptoken and cast it's address as erc20
    const ERC20Factory = new ERC20__factory(signer);
    const pt = ERC20Factory.attach(tranche.address);
    // Load other data
    const signerAddress = await signer.getAddress();
    const decimals = await token.decimals();
    const one = ethers.utils.parseUnits("1", decimals);
    console.log("Your token balance is : ", fmtFloat(await token.balanceOf(signerAddress), one));
    console.log("Your pt balance is : ", fmtFloat(await pt.balanceOf(signerAddress), one));

    const mintMore = readline.question("do you need to deposit (y/n): ");
    if (mintMore == "y") {
        const howMuch = readline.question("how much [decimal form]: ");
        const mintAmount = bnFloatMultiplier(one, Number.parseFloat(howMuch));
        if(BigNumber.from(await token.allowance(signerAddress, tranche.address)).lt(mintAmount)) {
          console.log("setting allowance");
          const gas = await gasPrice();
          let tx = await token.approve(tranche.address, ethers.constants.MaxUint256, {gasPrice: gas});
          await tx.wait(1);
        }
        // We mint using the input amount
        console.log("Deposited into tranche");
        const gas = await gasPrice();
        let tx = await tranche.connect(signer).deposit(mintAmount, signerAddress, {gasPrice: gas});
        await tx.wait(1);
        console.log("Deposit Completed");
    }

    let depositAmountStr = readline.question("Deposit amount of pt [decimal]: ");
    let depositAmount = bnFloatMultiplier(one, Number.parseFloat(depositAmountStr));

    console.log("Checking allowances");

    let txAwaits = [];
    if ((await token.allowance(signerAddress, vault.address)).lt(depositAmount)) {
        console.log("Setting unlimited allowance for underlying");
        const gas = await gasPrice();
        const tx = await token
        .connect(signer)
        .approve(vault.address, ethers.constants.MaxUint256, {gasPrice: gas});
        txAwaits.push(tx.wait(1));
    }
    if ((await pt.allowance(signerAddress, vault.address)).lt(depositAmount)) {
        console.log("Setting unlimited allowance for pt");
        const gas = await gasPrice();
        let tx = await pt
        .connect(signer)
        .approve(vault.address, ethers.constants.MaxUint256, {gasPrice: gas});
        txAwaits.push(tx.wait(1));
    }
    await Promise.all(txAwaits);
    console.log("Allowances completed");

    let ptAssets;
    let ptAmounts;
    if (BigNumber.from(tranche.address).lt(token.address)) {
      ptAssets = [tranche.address, token.address];
      ptAmounts = [0, depositAmount];
    } else {
      ptAssets = [token.address, tranche.address];
      ptAmounts = [depositAmount, 0];
    }
  
    let gas;
    let tx;
    if (depositAmount.gt(0)) {
      // Make the initalizing deposit into the ccPool
      console.log("Initial deposit into cc pool");
      gas = await gasPrice()
      // The manual gas limit here is because the estimator wasn't working well
      // real gas usage should be ~180k
      tx = await vault.connect(signer).joinPool(
        ccPoolId,
        signerAddress,
        signerAddress,
        {
          assets: ptAssets,
          maxAmountsIn: ptAmounts,
          userData: ethers.utils.defaultAbiCoder.encode(["uint256[]"], [ptAmounts]),
          fromInternalBalance: false,
        },
        { gasLimit: 250000, gasPrice: gas}
      );
      await tx.wait(1);
      console.log("Initial deposit finished");
    } else {
      depositAmountStr = readline.question("Deposit amount of pt [decimal]: ");
      depositAmount =  bnFloatMultiplier(one, Number.parseFloat(depositAmountStr));
    }

  
    // Trade into the pool to get the correct apy
    const tradeIn = await neededBonds(depositAmount, expectedAPY, timeStretch, trancheLength);
    gas = await gasPrice();
    console.log("Trading in ", fmtFloat(tradeIn, one), " bonds to set pool rate");
    const minOut = readline.question("Min trade output [in decimals]: ");
    console.log("Trade into the cc pool to set rate");
    tx = await vault.connect(signer).swap(
      {
        poolId: ccPoolId,
        kind: 0,
        assetIn: tranche.address,
        assetOut: token.address,
        amount: tradeIn,
        userData: "0x",
      },
      {
        sender: signerAddress,
        fromInternalBalance: false,
        recipient: signerAddress,
        toInternalBalance: false,
      },
      ethers.utils.parseUnits(
        Number.parseFloat(minOut).toFixed(decimals).toString(),
        decimals
      ),
      ethers.constants.MaxUint256
    );
    await tx.wait(1);
    console.log("Rate setting trade finished");
    console.log("Pt pool status", await vault.getPoolTokens(ccPoolId));
}